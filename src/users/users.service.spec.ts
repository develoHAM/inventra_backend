import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';
import { OwnershipService } from '../authorization/ownership.service';
import { NotificationEvent } from '../notifications/notification-events';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock };
    role: { findUnique: jest.Mock };
  };
  let storage: {
    putObject: jest.Mock;
    presignPutUrl: jest.Mock;
    presignGetUrl: jest.Mock;
    objectExists: jest.Mock;
    deleteObject: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };

  const caller: AuthUser = {
    id: 'manager-1',
    companyId: 'company-1',
    roleId: 3,
    roleCode: 'MANAGER',
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      role: { findUnique: jest.fn() },
    };
    storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      presignPutUrl: jest.fn().mockResolvedValue('https://minio/presigned-put'),
      presignGetUrl: jest.fn().mockResolvedValue('https://minio/presigned-get'),
      objectExists: jest.fn().mockResolvedValue(true),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = { emit: jest.fn().mockReturnValue(true) };
    // OwnershipService is a pure singleton (no deps) — use a real one
    // constructor: (prisma, ownership, storage, eventEmitter)
    service = new UsersService(
      prisma as any,
      new OwnershipService(),
      storage as any,
      eventEmitter as any,
    );
  });

  describe('approveMember', () => {
    const pendingMember = {
      id: 'member-1',
      companyId: 'company-1',
      status: UserStatus.PENDING_APPROVAL,
    };

    it('assigns the role and activates a PENDING member in the caller company', async () => {
      prisma.user.findFirst.mockResolvedValue(pendingMember);
      prisma.role.findUnique.mockResolvedValue({ id: 4, code: 'STAFF' });

      await service.approveMember(caller, 'member-1', { roleId: 4 });

      // lookup is SCOPED to the caller's company (tenant isolation)
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'member-1', companyId: 'company-1' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        data: { roleId: 4, status: UserStatus.ACTIVE },
      });
    });

    it('returns 404 for a member in another company (no cross-tenant leak)', async () => {
      // scoped query finds nothing → null
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.approveMember(caller, 'member-x', { roleId: 4 }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects approving a member who is not PENDING', async () => {
      prisma.user.findFirst.mockResolvedValue({
        ...pendingMember,
        status: UserStatus.ACTIVE,
      });

      await expect(
        service.approveMember(caller, 'member-1', { roleId: 4 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('blocks privilege escalation — cannot assign OWNER/ADMIN', async () => {
      prisma.user.findFirst.mockResolvedValue(pendingMember);
      prisma.role.findUnique.mockResolvedValue({ id: 2, code: 'OWNER' });

      await expect(
        service.approveMember(caller, 'member-1', { roleId: 2 }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects an unknown role id', async () => {
      prisma.user.findFirst.mockResolvedValue(pendingMember);
      prisma.role.findUnique.mockResolvedValue(null);

      await expect(
        service.approveMember(caller, 'member-1', { roleId: 999 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not company-scope the lookup for an ADMIN caller', async () => {
      const adminCaller: AuthUser = {
        ...caller,
        companyId: null,
        roleCode: 'ADMIN',
      };
      prisma.user.findFirst.mockResolvedValue({
        id: 'member-1',
        companyId: 'company-9',
        status: UserStatus.PENDING_APPROVAL,
      });
      prisma.role.findUnique.mockResolvedValue({ id: 4, code: 'STAFF' });

      await service.approveMember(adminCaller, 'member-1', { roleId: 4 });

      // ADMIN → scopeToCompany returns {} → no companyId filter → any tenant reachable
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'member-1' },
      });
    });
  });

  describe('approveCompany', () => {
    it('activates the company owner', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.PENDING_APPROVAL,
      });

      await service.approveCompany('company-1');

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { companyId: 'company-1', role: { code: 'OWNER' } },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'owner-1' },
        data: { status: UserStatus.ACTIVE },
      });
    });

    it('emits company.approved with the ids, only after the owner is activated', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.PENDING_APPROVAL,
      });
      prisma.user.update.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.ACTIVE,
      });

      const result = await service.approveCompany('company-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.COMPANY_APPROVED,
        { companyId: 'company-1', ownerUserId: 'owner-1' },
      );
      // emit-after-commit: never announce an approval before it's written
      expect(prisma.user.update.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0],
      );
      // the caller still gets the updated owner back, unchanged by the emit
      expect(result).toEqual({ id: 'owner-1', status: UserStatus.ACTIVE });
    });

    it('does not emit when the owner update fails', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.PENDING_APPROVAL,
      });
      prisma.user.update.mockRejectedValue(new Error('db down'));

      await expect(service.approveCompany('company-1')).rejects.toThrow(
        'db down',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('returns 404 when the company has no owner', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.approveCompany('company-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rejects approving an owner who is not PENDING (and emits nothing)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.ACTIVE,
      });

      await expect(service.approveCompany('company-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('findActiveMember', () => {
    it('returns an active same-company member with role included', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u1',
        role: { code: 'MANAGER' },
      });

      const found = await service.findActiveMember('u1', 'company-1');

      expect(found).toEqual({ id: 'u1', role: { code: 'MANAGER' } });
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'u1',
          companyId: 'company-1',
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        include: { role: true },
      });
    });

    it('returns null when there is no match (wrong company / inactive / deleted)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      expect(await service.findActiveMember('u1', 'company-1')).toBeNull();
    });
  });

  describe('avatar (self-service)', () => {
    it('uploadAvatar targets the caller, stores under users/<caller.id>/<uuid>.<ext>, deletes old', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: 'users/old.jpg',
      });
      prisma.user.update.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: 'k',
      });

      await service.uploadAvatar(caller, {
        buffer: Buffer.from('x'),
        mimetype: 'image/png',
      } as any);

      // the self row is looked up by the caller's own id (never a param)
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'manager-1', deletedAt: null },
      });
      const putKey = storage.putObject.mock.calls[0][0];
      expect(putKey).toMatch(/^users\/manager-1\/[0-9a-f-]+\.png$/);
      expect(storage.putObject).toHaveBeenCalledWith(
        putKey,
        expect.any(Buffer),
        'image/png',
      );
      expect(storage.deleteObject).toHaveBeenCalledWith('users/old.jpg');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'manager-1' },
        data: { profileImageUrl: putKey },
      });
    });

    it('presignAvatarUpload returns an upload URL + key without touching the user', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: null,
      });

      const res = await service.presignAvatarUpload(caller, {
        contentType: 'image/jpeg',
      } as any);

      expect(res.key).toMatch(/^users\/manager-1\/[0-9a-f-]+\.jpg$/);
      expect(res.uploadUrl).toBe('https://minio/presigned-put');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('confirmAvatar rejects a key not under the caller prefix (400)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: null,
      });

      await expect(
        service.confirmAvatar(caller, {
          key: 'users/other-user/x.jpg',
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(storage.objectExists).not.toHaveBeenCalled();
    });

    it('confirmAvatar rejects a key whose object is missing (400)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: null,
      });
      storage.objectExists.mockResolvedValue(false);

      await expect(
        service.confirmAvatar(caller, {
          key: 'users/manager-1/x.jpg',
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('confirmAvatar sets profileImageUrl and returns a presented (presigned) user', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: null,
      });
      prisma.user.update.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: 'users/manager-1/x.jpg',
      });

      const res = await service.confirmAvatar(caller, {
        key: 'users/manager-1/x.jpg',
      } as any);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'manager-1' },
        data: { profileImageUrl: 'users/manager-1/x.jpg' },
      });
      expect(res.profileImageUrl).toBe('https://minio/presigned-get');
    });
  });
});
