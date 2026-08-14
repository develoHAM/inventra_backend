import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PlacementsService } from './placements.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('PlacementsService', () => {
  let service: PlacementsService;
  let prisma: {
    companyStoreProduct: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let corners: { findOne: jest.Mock; assertWorksCorner: jest.Mock };
  let products: { findInCompany: jest.Mock };

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
  };
  const CORNER = {
    id: 'corner-1',
    companyId: 'company-1',
    managerUserId: 'mgr-1',
  };

  beforeEach(() => {
    prisma = {
      companyStoreProduct: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({ id: 1 }),
      },
    };
    corners = {
      findOne: jest.fn().mockResolvedValue(CORNER),
      assertWorksCorner: jest.fn().mockResolvedValue(CORNER),
    };
    products = { findInCompany: jest.fn().mockResolvedValue({ id: 'prod-1' }) };
    service = new PlacementsService(
      prisma as any,
      corners as any,
      products as any,
    );
  });

  describe('create', () => {
    it('places a product after authorizing the corner and validating the product', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue(null); // none existing

      await service.create(owner, 'corner-1', {
        productId: 'prod-1',
        targetStockQuantity: 5,
      } as any);

      expect(corners.assertWorksCorner).toHaveBeenCalledWith(owner, 'corner-1');
      expect(products.findInCompany).toHaveBeenCalledWith('prod-1', 'company-1');
      expect(prisma.companyStoreProduct.create).toHaveBeenCalledWith({
        data: {
          targetStockQuantity: 5,
          companyStoreId: 'corner-1',
          productId: 'prod-1',
        },
      });
    });

    it('rejects an invalid product with 400', async () => {
      products.findInCompany.mockResolvedValue(null);
      await expect(
        service.create(owner, 'corner-1', { productId: 'bad' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.companyStoreProduct.create).not.toHaveBeenCalled();
    });

    it('409s when a live placement already exists', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue({
        id: 9,
        deletedAt: null,
      });
      await expect(
        service.create(owner, 'corner-1', { productId: 'prod-1' } as any),
      ).rejects.toThrow(ConflictException);
      expect(prisma.companyStoreProduct.create).not.toHaveBeenCalled();
    });

    it('revives a soft-deleted placement instead of inserting', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue({
        id: 9,
        deletedAt: new Date(),
      });

      await service.create(owner, 'corner-1', {
        productId: 'prod-1',
        targetStockQuantity: 3,
      } as any);

      expect(prisma.companyStoreProduct.create).not.toHaveBeenCalled();
      expect(prisma.companyStoreProduct.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { targetStockQuantity: 3, deletedAt: null, deletedByUserId: null },
      });
    });
  });

  describe('findOne', () => {
    it('404s a placement absent from this corner (scoped)', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue(null);
      await expect(service.findOne(owner, 'corner-1', 9)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.companyStoreProduct.findFirst).toHaveBeenCalledWith({
        where: { id: 9, companyStoreId: 'corner-1', deletedAt: null },
      });
    });
  });

  describe('remove', () => {
    it('soft-deletes and stamps the deleter', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue({
        id: 9,
        companyStoreId: 'corner-1',
      });
      await service.remove(owner, 'corner-1', 9);
      expect(prisma.companyStoreProduct.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
      });
    });
  });
});
