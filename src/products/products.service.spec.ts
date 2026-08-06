import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('ProductsService', () => {
  let service: ProductsService;
  let prisma: {
    product: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let categories: { findActive: jest.Mock };
  let brands: { findInCompany: jest.Mock };

  const owner: AuthUser = {
    id: 'owner-1', companyId: 'company-1', roleId: 2,
    roleCode: 'OWNER', status: UserStatus.ACTIVE,
  };
  const manager: AuthUser = {
    id: 'mgr-1', companyId: 'company-1', roleId: 3,
    roleCode: 'MANAGER', status: UserStatus.ACTIVE,
  };
  const admin: AuthUser = {
    id: 'admin-1', companyId: null, roleId: 1,
    roleCode: 'ADMIN', status: UserStatus.ACTIVE,
  };

  const dto = {
    name: 'Widget', barcode: 'BC-1', categoryId: 10, brandId: 20, priceKrw: 1000,
  };

  beforeEach(() => {
    prisma = {
      product: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'prod-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    categories = { findActive: jest.fn().mockResolvedValue({ id: 10 }) };
    brands = { findInCompany: jest.fn().mockResolvedValue({ id: 20 }) };
    // constructor order: (prisma, ownership, categories, brands)
    service = new ProductsService(
      prisma as any,
      new OwnershipService(),
      categories as any,
      brands as any,
    );
  });

  describe('create', () => {
    it('creates a product owned by the caller company', async () => {
      prisma.product.findFirst.mockResolvedValue(null); // barcode available

      await service.create(owner, { ...dto } as any);

      expect(brands.findInCompany).toHaveBeenCalledWith(20, 'company-1');
      expect(categories.findActive).toHaveBeenCalledWith(10);
      expect(prisma.product.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          barcode: 'BC-1',
          companyId: 'company-1',
          createdByUserId: 'owner-1',
        }),
      });
    });

    it('rejects an invalid brand with 400', async () => {
      brands.findInCompany.mockResolvedValue(null);
      await expect(service.create(owner, { ...dto } as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('rejects a missing category with 400', async () => {
      categories.findActive.mockResolvedValue(null);
      await expect(service.create(owner, { ...dto } as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a duplicate barcode with 409', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(service.create(owner, { ...dto } as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('lets ADMIN create for a supplied companyId', async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      await service.create(admin, { ...dto, companyId: 'company-9' } as any);

      expect(brands.findInCompany).toHaveBeenCalledWith(20, 'company-9');
      expect(prisma.product.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          companyId: 'company-9',
          createdByUserId: 'admin-1',
        }),
      });
    });

    it('rejects ADMIN create without a companyId (400)', async () => {
      await expect(service.create(admin, { ...dto } as any)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('findOne', () => {
    it('404s a cross-tenant / absent product and scopes the lookup', async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(service.findOne(owner, 'x')).rejects.toThrow(NotFoundException);
      expect(prisma.product.findFirst).toHaveBeenCalledWith({
        where: { id: 'x', companyId: 'company-1', deletedAt: null },
      });
    });
  });

  describe('update', () => {
    it('re-validates a changed brand against the product company (400)', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 'p1', companyId: 'company-1' });
      brands.findInCompany.mockResolvedValue(null);

      await expect(
        service.update(owner, 'p1', { brandId: 99 } as any),
      ).rejects.toThrow(BadRequestException);
      expect(brands.findInCompany).toHaveBeenCalledWith(99, 'company-1');
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });

  describe('remove (creator-scoped)', () => {
    it('lets an OWNER delete any company product and stamps the audit', async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: 'p1', companyId: 'company-1', createdByUserId: 'someone-else',
      });

      await service.remove(owner, 'p1');

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
      });
    });

    it('blocks a MANAGER from deleting a product they did not create (403)', async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: 'p1', companyId: 'company-1', createdByUserId: 'someone-else',
      });

      await expect(service.remove(manager, 'p1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('lets a MANAGER delete their own product', async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: 'p1', companyId: 'company-1', createdByUserId: 'mgr-1',
      });

      await service.remove(manager, 'p1');

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { deletedAt: expect.any(Date), deletedByUserId: 'mgr-1' },
      });
    });
  });
});
