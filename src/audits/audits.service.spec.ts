import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditsService } from './audits.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('AuditsService', () => {
  let service: AuditsService;
  let prisma: any;
  let corners: { assertWorksCorner: jest.Mock; findOne: jest.Mock };
  let inventory: { recordWithinTransaction: jest.Mock };
  let transaction: any;

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
  };
  const cornerId = '11111111-1111-1111-1111-111111111111';
  const auditId = '22222222-2222-2222-2222-222222222222';

  const createDto = {
    title: 'Monthly count',
    auditedDate: '2026-08-28',
    items: [
      { companyStoreProductId: 7, productQuantity: 12 },
      { companyStoreProductId: 8, productQuantity: 0 },
    ],
  };

  const unappliedAudit = {
    id: auditId,
    appliedAt: null,
    inventoryAuditItems: [
      { companyStoreProductId: 7, productQuantity: 12 },
      { companyStoreProductId: 8, productQuantity: 0 },
    ],
  };

  beforeEach(() => {
    transaction = {
      inventoryAudit: {
        update: jest
          .fn()
          .mockResolvedValue({ id: auditId, appliedAt: new Date() }),
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue({ id: auditId, inventoryAuditItems: [] }),
      },
      inventoryAuditItem: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      companyStoreProduct: {
        findMany: jest.fn().mockImplementation(async ({ where }: any) => {
          const requestedIds: number[] = where.id.in;
          return requestedIds.map((id) => ({ id }));
        }),
      },
      inventoryAudit: {
        create: jest
          .fn()
          .mockResolvedValue({ id: auditId, inventoryAuditItems: [] }),
        findFirst: jest.fn().mockResolvedValue(unappliedAudit),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: auditId }),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: any) => callback(transaction)),
    };
    corners = {
      assertWorksCorner: jest
        .fn()
        .mockResolvedValue({ id: cornerId, companyId: 'company-1' }),
      findOne: jest.fn().mockResolvedValue({ id: cornerId }),
    };
    inventory = { recordWithinTransaction: jest.fn().mockResolvedValue({ id: 1 }) };
    service = new AuditsService(prisma, corners as any, inventory as any);
  });

  it('create validates items and writes the audit + items by relation', async () => {
    await service.create(owner, cornerId, createDto as any);

    expect(corners.assertWorksCorner).toHaveBeenCalledWith(owner, cornerId);
    const arg = prisma.inventoryAudit.create.mock.calls[0][0];
    expect(arg.data.inventoryAuditItems.create[0]).toEqual({
      productQuantity: 12,
      companyStoreProduct: {
        connect: { id_companyStoreId: { id: 7, companyStoreId: cornerId } },
      },
    });
  });

  it('create rejects a foreign-placement line (400)', async () => {
    prisma.companyStoreProduct.findMany.mockResolvedValue([{ id: 7 }]); // only 1 of 2
    await expect(
      service.create(owner, cornerId, createDto as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.inventoryAudit.create).not.toHaveBeenCalled();
  });

  it('findOne 404s an absent audit', async () => {
    prisma.inventoryAudit.findFirst.mockResolvedValue(null);
    await expect(
      service.findOne(owner, cornerId, auditId),
    ).rejects.toThrow(NotFoundException);
  });

  it('update checks corner authority and swaps the item set while unapplied', async () => {
    await service.update(owner, cornerId, auditId, {
      title: 'Recount',
      items: [{ companyStoreProductId: 7, productQuantity: 9 }],
    } as any);

    expect(corners.assertWorksCorner).toHaveBeenCalledWith(owner, cornerId);
    expect(transaction.inventoryAuditItem.deleteMany).toHaveBeenCalledWith({
      where: { inventoryAuditId: auditId, companyStoreId: cornerId },
    });
    expect(transaction.inventoryAuditItem.createMany).toHaveBeenCalled();
  });

  it('update on an applied audit is 409', async () => {
    prisma.inventoryAudit.findFirst.mockResolvedValue({
      ...unappliedAudit,
      appliedAt: new Date(),
    });
    await expect(
      service.update(owner, cornerId, auditId, { title: 'x' } as any),
    ).rejects.toThrow(ConflictException);
  });

  it('remove soft-deletes an unapplied audit', async () => {
    await service.remove(owner, cornerId, auditId);
    expect(prisma.inventoryAudit.update).toHaveBeenCalledWith({
      where: { id_companyStoreId: { id: auditId, companyStoreId: cornerId } },
      data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
    });
  });

  it('apply records an ADJUSTMENT per line (source=AUDIT) and stamps appliedAt', async () => {
    await service.apply(owner, cornerId, auditId);

    expect(inventory.recordWithinTransaction).toHaveBeenCalledTimes(2);
    expect(inventory.recordWithinTransaction).toHaveBeenNthCalledWith(
      1,
      transaction,
      7,
      { transactionType: 'ADJUSTMENT', quantity: 12 },
      'owner-1',
      { type: 'AUDIT', id: auditId },
    );
    expect(inventory.recordWithinTransaction).toHaveBeenNthCalledWith(
      2,
      transaction,
      8,
      { transactionType: 'ADJUSTMENT', quantity: 0 },
      'owner-1',
      { type: 'AUDIT', id: auditId },
    );
    expect(transaction.inventoryAudit.update).toHaveBeenCalledWith({
      where: { id_companyStoreId: { id: auditId, companyStoreId: cornerId } },
      data: { appliedAt: expect.any(Date), appliedByUserId: 'owner-1' },
      include: { inventoryAuditItems: true },
    });
  });

  it('apply on an already-applied audit is 409', async () => {
    prisma.inventoryAudit.findFirst.mockResolvedValue({
      ...unappliedAudit,
      appliedAt: new Date(),
    });
    await expect(service.apply(owner, cornerId, auditId)).rejects.toThrow(
      ConflictException,
    );
    expect(inventory.recordWithinTransaction).not.toHaveBeenCalled();
  });
});
