import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CornersService } from './corners.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('CornersService', () => {
  let service: CornersService;
  let prisma: {
    companyStore: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    user: { findFirst: jest.Mock; update: jest.Mock };
  };
  let stores: { findActive: jest.Mock };
  let users: { findActiveMember: jest.Mock };

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
  };
  const admin: AuthUser = {
    id: 'admin-1',
    companyId: null,
    roleId: 1,
    roleCode: 'ADMIN',
    status: UserStatus.ACTIVE,
  };
  const manager: AuthUser = {
    id: 'mgr-1',
    companyId: 'company-1',
    roleId: 3,
    roleCode: 'MANAGER',
    status: UserStatus.ACTIVE,
  };
  const staff: AuthUser = {
    id: 'staff-1',
    companyId: 'company-1',
    companyStoreId: 'c1',
    roleId: 4,
    roleCode: 'STAFF',
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      companyStore: {
        create: jest.fn().mockResolvedValue({ id: 'corner-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    stores = { findActive: jest.fn().mockResolvedValue({ id: 'store-1' }) };
    users = {
      findActiveMember: jest
        .fn()
        .mockResolvedValue({ id: 'u1', role: { code: 'MANAGER' } }),
    };
    // constructor order: (prisma, ownership, stores, users)
    service = new CornersService(
      prisma as any,
      new OwnershipService(),
      stores as any,
      users as any,
    );
  });

  describe('create', () => {
    it('creates a corner owned by the caller company after validating the store', async () => {
      await service.create(owner, { storeId: 'store-1', name: 'A1' } as any);

      expect(stores.findActive).toHaveBeenCalledWith('store-1');
      expect(prisma.companyStore.create).toHaveBeenCalledWith({
        data: {
          storeId: 'store-1',
          name: 'A1',
          companyId: 'company-1',
          managerUserId: null,
        },
      });
    });

    it('rejects an invalid store with 400', async () => {
      stores.findActive.mockResolvedValue(null);
      await expect(
        service.create(owner, { storeId: 'bad' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.companyStore.create).not.toHaveBeenCalled();
    });

    it('validates a supplied managerUserId (400 when not an active MANAGER)', async () => {
      users.findActiveMember.mockResolvedValue(null);
      await expect(
        service.create(owner, { storeId: 'store-1', managerUserId: 'bad' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.companyStore.create).not.toHaveBeenCalled();
    });

    it('lets ADMIN create for a supplied companyId', async () => {
      await service.create(admin, {
        storeId: 'store-1',
        companyId: 'company-9',
      } as any);

      expect(prisma.companyStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ companyId: 'company-9' }),
        }),
      );
    });

    it('rejects ADMIN create without a companyId (400)', async () => {
      await expect(
        service.create(admin, { storeId: 'store-1' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne', () => {
    it('404s a cross-tenant / absent corner and scopes the lookup', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(null);

      await expect(service.findOne(owner, 'x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.companyStore.findFirst).toHaveBeenCalledWith({
        where: { id: 'x', companyId: 'company-1', deletedAt: null },
      });
    });
  });

  describe('remove', () => {
    it('soft-deletes and stamps the deleter', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'corner-1',
        companyId: 'company-1',
      });

      await service.remove(owner, 'corner-1');

      expect(prisma.companyStore.update).toHaveBeenCalledWith({
        where: { id: 'corner-1' },
        data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
      });
    });
  });

  describe('assignManager', () => {
    it('sets managerUserId for an eligible MANAGER target (owner caller)', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: null,
      });
      users.findActiveMember.mockResolvedValue({
        id: 'u1',
        role: { code: 'MANAGER' },
      });

      await service.assignManager(owner, 'c1', { userId: 'u1' } as any);

      expect(users.findActiveMember).toHaveBeenCalledWith('u1', 'company-1');
      expect(prisma.companyStore.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { managerUserId: 'u1' },
      });
    });

    it('rejects a non-MANAGER target with 400', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: null,
      });
      users.findActiveMember.mockResolvedValue({
        id: 'u1',
        role: { code: 'STAFF' },
      });

      await expect(
        service.assignManager(owner, 'c1', { userId: 'u1' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.companyStore.update).not.toHaveBeenCalled();
    });

    it('forbids a MANAGER caller from appointing a manager (403)', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'mgr-1',
      });

      await expect(
        service.assignManager(manager, 'c1', { userId: 'u1' } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.companyStore.update).not.toHaveBeenCalled();
    });
  });

  describe('addStaff', () => {
    it('lets the corner MANAGER add an active member (sets companyStoreId)', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'mgr-1',
      });
      users.findActiveMember.mockResolvedValue({
        id: 'u2',
        role: { code: 'STAFF' },
      });

      await service.addStaff(manager, 'c1', { userId: 'u2' } as any);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u2' },
        data: { companyStoreId: 'c1' },
      });
    });

    it('forbids a MANAGER from staffing a corner they do not manage (403)', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'someone-else',
      });

      await expect(
        service.addStaff(manager, 'c1', { userId: 'u2' } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects an ineligible staff target with 400', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'mgr-1',
      });
      users.findActiveMember.mockResolvedValue(null);

      await expect(
        service.addStaff(manager, 'c1', { userId: 'bad' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('removeStaff', () => {
    it('404s when the user is not staff of this corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'mgr-1',
      });
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.removeStaff(manager, 'c1', 'u2')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('unsets companyStoreId for a current staff member', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'mgr-1',
      });
      prisma.user.findFirst.mockResolvedValue({ id: 'u2', companyStoreId: 'c1' });

      await service.removeStaff(manager, 'c1', 'u2');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u2' },
        data: { companyStoreId: null },
      });
    });
  });

  describe('assertManages', () => {
    it('returns the corner for an OWNER', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'x',
      });
      await expect(service.assertManages(owner, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a MANAGER who does not manage the corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'someone-else',
      });
      await expect(service.assertManages(manager, 'c1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('404s a cross-tenant / absent corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(null);
      await expect(service.assertManages(owner, 'c9')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('assertWorksCorner', () => {
    it('lets the corner MANAGER through', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'mgr-1',
      });
      await expect(service.assertWorksCorner(manager, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a MANAGER who does not manage the corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'someone-else',
      });
      await expect(service.assertWorksCorner(manager, 'c1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lets the STAFF member assigned to the corner through', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        managerUserId: 'mgr-1',
      });
      await expect(service.assertWorksCorner(staff, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a STAFF member not assigned to the corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c2',
        companyId: 'company-1',
        managerUserId: 'mgr-1',
      });
      await expect(service.assertWorksCorner(staff, 'c2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lets an OWNER through any corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c9',
        companyId: 'company-1',
        managerUserId: 'x',
      });
      await expect(service.assertWorksCorner(owner, 'c9')).resolves.toEqual(
        expect.objectContaining({ id: 'c9' }),
      );
    });
  });
});
