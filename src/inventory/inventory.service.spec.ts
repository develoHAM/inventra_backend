import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('InventoryService', () => {
  let service: InventoryService;
  let prisma: any;
  let corners: { assertWorksCorner: jest.Mock; findOne: jest.Mock };
  let transaction: any;

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
  };
  const placement = {
    id: 7,
    companyStoreId: 'corner-1',
    companyId: 'company-1',
  };

  beforeEach(() => {
    transaction = {
      companyStoreProductStock: {
        findUnique: jest.fn().mockResolvedValue({
          companyStoreProductId: 7,
          availableQuantity: 5,
          sampleQuantity: 0,
          damagedQuantity: 0,
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryTransaction: { create: jest.fn().mockResolvedValue({ id: 100 }) },
    };
    prisma = {
      companyStoreProduct: {
        findFirst: jest.fn().mockResolvedValue(placement),
      },
      inventoryTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: any) => callback(transaction)),
    };
    corners = {
      assertWorksCorner: jest.fn().mockResolvedValue(placement),
      findOne: jest.fn().mockResolvedValue({ id: 'corner-1' }),
    };
    service = new InventoryService(prisma, corners as any);
  });

  it('SALE decrements available via a guarded updateMany and records before/after', async () => {
    await service.record(owner, 'corner-1', 7, {
      transactionType: 'SALE',
      quantity: 2,
    } as any);

    expect(corners.assertWorksCorner).toHaveBeenCalledWith(owner, 'corner-1');
    expect(transaction.companyStoreProductStock.updateMany).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7, availableQuantity: { gte: 2 } },
      data: { availableQuantity: { decrement: 2 } },
    });
    expect(transaction.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyStoreProductId: 7,
        transactionType: 'SALE',
        quantity: 2,
        quantityBefore: 5,
        quantityAfter: 3,
        createdByUserId: 'owner-1',
        sourceType: null,
        sourceId: null,
      }),
    });
  });

  it('409s when the guarded decrement finds insufficient stock (count 0)', async () => {
    transaction.companyStoreProductStock.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.record(owner, 'corner-1', 7, {
        transactionType: 'SALE',
        quantity: 99,
      } as any),
    ).rejects.toThrow(ConflictException);
    expect(transaction.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('RESTOCK increments available', async () => {
    await service.record(owner, 'corner-1', 7, {
      transactionType: 'RESTOCK',
      quantity: 4,
    } as any);

    expect(transaction.companyStoreProductStock.update).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7 },
      data: { availableQuantity: { increment: 4 } },
    });
  });

  it('ADJUSTMENT sets available to the counted total', async () => {
    await service.record(owner, 'corner-1', 7, {
      transactionType: 'ADJUSTMENT',
      quantity: 12,
    } as any);

    expect(transaction.companyStoreProductStock.update).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7 },
      data: { availableQuantity: 12 },
    });
    expect(transaction.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quantityBefore: 5, quantityAfter: 12 }),
    });
  });

  it('BREAKAGE decrements available (guarded) then increments damaged', async () => {
    await service.record(owner, 'corner-1', 7, {
      transactionType: 'BREAKAGE',
      quantity: 1,
    } as any);

    expect(transaction.companyStoreProductStock.updateMany).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7, availableQuantity: { gte: 1 } },
      data: { availableQuantity: { decrement: 1 } },
    });
    expect(transaction.companyStoreProductStock.update).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7 },
      data: { damagedQuantity: { increment: 1 } },
    });
  });

  it('rejects quantity < 1 for a movement type (400)', async () => {
    await expect(
      service.record(owner, 'corner-1', 7, {
        transactionType: 'SALE',
        quantity: 0,
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s an absent placement', async () => {
    prisma.companyStoreProduct.findFirst.mockResolvedValue(null);

    await expect(
      service.record(owner, 'corner-1', 7, {
        transactionType: 'SALE',
        quantity: 1,
      } as any),
    ).rejects.toThrow(NotFoundException);
  });

  describe('findForPlacement', () => {
    it('returns the placement ledger newest-first', async () => {
      await service.findForPlacement(owner, 'corner-1', 7);

      expect(prisma.inventoryTransaction.findMany).toHaveBeenCalledWith({
        where: { companyStoreProductId: 7 },
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});
