import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock };
    role: { findUnique: jest.Mock };
  };

  const caller: AuthUser = {
    id: 'manager-1',
    companyId: 'company-1',
    roleId: 3,
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      role: { findUnique: jest.fn() },
    };
    service = new UsersService(prisma as any);
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

    it('returns 404 when the company has no owner', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.approveCompany('company-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects approving an owner who is not PENDING', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.ACTIVE,
      });

      await expect(service.approveCompany('company-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
