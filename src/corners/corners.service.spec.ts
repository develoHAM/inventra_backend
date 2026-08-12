import { BadRequestException, NotFoundException } from '@nestjs/common';
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
});
