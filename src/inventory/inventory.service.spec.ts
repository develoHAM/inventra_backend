import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

describe('InventoryService', () => {
  let service: InventoryService;
  let prisma: any;
  let corners: { assertWorksCorner: jest.Mock; findOne: jest.Mock };
  let transaction: any;
  let eventEmitter: { emit: jest.Mock };

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
          reservedQuantity: 0,
          sampleQuantity: 0,
          damagedQuantity: 0,
          targetStockQuantity: 0, // no target → never alerts (set per test)
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
    eventEmitter = { emit: jest.fn().mockReturnValue(true) };
    // constructor: (prisma, corners, eventEmitter)
    service = new InventoryService(prisma, corners as any, eventEmitter as any);
  });

  // Give the mocked stock row a target, keeping the other buckets.
  const stockWith = (overrides: Record<string, number>) =>
    transaction.companyStoreProductStock.findUnique.mockResolvedValue({
      companyStoreProductId: 7,
      availableQuantity: 5,
      reservedQuantity: 0,
      sampleQuantity: 0,
      damagedQuantity: 0,
      targetStockQuantity: 0,
      ...overrides,
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

  it('recordWithinTransaction applies an ADJUSTMENT and stamps the source (runs on the passed tx)', async () => {
    const result = await service.recordWithinTransaction(
      transaction,
      7,
      { transactionType: 'ADJUSTMENT', quantity: 12 } as any,
      'owner-1',
      { type: 'AUDIT', id: 'audit-1' } as any,
    );

    expect(transaction.companyStoreProductStock.update).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7 },
      data: { availableQuantity: 12 },
    });
    expect(transaction.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        transactionType: 'ADJUSTMENT',
        quantityBefore: 5,
        quantityAfter: 12,
        createdByUserId: 'owner-1',
        sourceType: 'AUDIT',
        sourceId: 'audit-1',
      }),
    });
    // returns the ledger row AND a report of what happened to available stock
    expect(result).toEqual({
      ledgerEntry: { id: 100 },
      stockChange: {
        placementId: 7,
        availableBefore: 5,
        availableAfter: 12, // a 'set' effect: available becomes q
        targetStockQuantity: 0,
      },
    });
    // it never emits on its own — the caller decides, after its commit
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  describe('stock-change report', () => {
    it('a SALE lowers available by q', async () => {
      const { stockChange } = await service.recordWithinTransaction(
        transaction,
        7,
        { transactionType: 'SALE', quantity: 2 } as any,
        'owner-1',
      );

      expect(stockChange).toEqual({
        placementId: 7,
        availableBefore: 5,
        availableAfter: 3,
        targetStockQuantity: 0,
      });
    });

    it('tracks AVAILABLE even when the primary bucket is another one (RESERVATION_RELEASE)', async () => {
      stockWith({ availableQuantity: 5, reservedQuantity: 3 });

      const { stockChange } = await service.recordWithinTransaction(
        transaction,
        7,
        { transactionType: 'RESERVATION_RELEASE', quantity: 2 } as any,
        'owner-1',
      );

      // reserved → available: available rises by q
      expect(stockChange.availableBefore).toBe(5);
      expect(stockChange.availableAfter).toBe(7);
    });

    it('an effect that never touches available reports no change (CUSTOMER_DAMAGED_RETURN → damaged only)', async () => {
      stockWith({ availableQuantity: 5, damagedQuantity: 4 });

      const { stockChange } = await service.recordWithinTransaction(
        transaction,
        7,
        { transactionType: 'CUSTOMER_DAMAGED_RETURN', quantity: 3 } as any,
        'owner-1',
      );

      expect(stockChange.availableBefore).toBe(5);
      expect(stockChange.availableAfter).toBe(5);
    });
  });

  describe('record: stock alerts are emitted only after the transaction commits', () => {
    it('returns just the ledger row (HTTP response unchanged)', async () => {
      const result = await service.record(owner, 'corner-1', 7, {
        transactionType: 'RESTOCK',
        quantity: 1,
      } as any);

      expect(result).toEqual({ id: 100 });
    });

    it('emits stock.belowTarget when available crosses below target (5 → 3, target 4)', async () => {
      stockWith({ availableQuantity: 5, targetStockQuantity: 4 });

      await service.record(owner, 'corner-1', 7, {
        transactionType: 'SALE',
        quantity: 2,
      } as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.STOCK_BELOW_TARGET,
        { placementId: 7, availableQuantity: 3, targetStockQuantity: 4 },
      );
      // emitted after the transaction finished, never inside it
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0],
      );
    });

    it('does not emit when stock stays at or above target', async () => {
      stockWith({ availableQuantity: 10, targetStockQuantity: 4 });

      await service.record(owner, 'corner-1', 7, {
        transactionType: 'SALE',
        quantity: 6, // 10 → 4: equal to target is not below it
      } as any);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not emit when the placement has no target (0)', async () => {
      stockWith({ availableQuantity: 5, targetStockQuantity: 0 });

      await service.record(owner, 'corner-1', 7, {
        transactionType: 'SALE',
        quantity: 5,
      } as any);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not emit when the transaction fails (rolled back → nothing to announce)', async () => {
      stockWith({ availableQuantity: 5, targetStockQuantity: 4 });
      transaction.inventoryTransaction.create.mockRejectedValue(
        new Error('ledger write failed'),
      );

      await expect(
        service.record(owner, 'corner-1', 7, {
          transactionType: 'SALE',
          quantity: 2,
        } as any),
      ).rejects.toThrow('ledger write failed');
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('emitStockAlerts', () => {
    it('emits one event per placement that crossed, and nothing for the rest', () => {
      service.emitStockAlerts([
        { placementId: 1, availableBefore: 10, availableAfter: 2, targetStockQuantity: 5 },
        { placementId: 2, availableBefore: 10, availableAfter: 9, targetStockQuantity: 5 },
      ]);

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.STOCK_BELOW_TARGET,
        { placementId: 1, availableQuantity: 2, targetStockQuantity: 5 },
      );
    });
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
