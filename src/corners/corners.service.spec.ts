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
  };
  let stores: { findActive: jest.Mock };

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
    companyStoreId: 'c1', // the manager's branch
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
    };
    stores = { findActive: jest.fn().mockResolvedValue({ id: 'store-1' }) };
    // constructor order: (prisma, ownership, stores)
    service = new CornersService(
      prisma as any,
      new OwnershipService(),
      stores as any,
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

  describe('assertWorksCorner', () => {
    const cornerRow = (id: string) => ({ id: id, companyId: 'company-1' });

    it('lets a MANAGER through their own branch', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(service.assertWorksCorner(manager, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a MANAGER on a branch that is not theirs', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c2'));
      await expect(service.assertWorksCorner(manager, 'c2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('403s a MANAGER who has no branch, on every branch', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(
        service.assertWorksCorner({ ...manager, companyStoreId: null }, 'c1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets the STAFF member assigned to the corner through', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(service.assertWorksCorner(staff, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a STAFF member not assigned to the corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c2'));
      await expect(service.assertWorksCorner(staff, 'c2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lets an OWNER through any corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c9'));
      await expect(service.assertWorksCorner(owner, 'c9')).resolves.toEqual(
        expect.objectContaining({ id: 'c9' }),
      );
    });

    it('404s a cross-tenant / absent corner before any role check', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(null);
      await expect(service.assertWorksCorner(manager, 'c1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('lockLiveCorner', () => {
    it("writes the live corner's row (taking its lock) and reports that it exists", async () => {
      const transaction = {
        companyStore: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      await expect(
        service.lockLiveCorner(transaction as any, 'corner-b', 'company-1'),
      ).resolves.toBe(true);
      expect(transaction.companyStore.updateMany).toHaveBeenCalledWith({
        where: { id: 'corner-b', companyId: 'company-1', deletedAt: null },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it('reports false for a corner that is deleted or in another company', async () => {
      const transaction = {
        companyStore: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };

      await expect(
        service.lockLiveCorner(transaction as any, 'corner-x', 'company-1'),
      ).resolves.toBe(false);
    });
  });
});
