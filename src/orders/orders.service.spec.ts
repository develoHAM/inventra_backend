import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('OrdersService', () => {
  let service: OrdersService;
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
  const cornerId = '11111111-1111-1111-1111-111111111111';
  const orderId = '22222222-2222-2222-2222-222222222222';

  const createDto = {
    title: 'Weekend restock',
    orderDate: '2026-08-23',
    items: [
      { companyStoreProductId: 7, productOrderQuantity: 10 },
      { companyStoreProductId: 8, productOrderQuantity: 4 },
    ],
  };

  beforeEach(() => {
    transaction = {
      order: {
        update: jest.fn().mockResolvedValue({}),
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue({ id: orderId, orderItems: [] }),
      },
      orderItem: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      companyStoreProduct: {
        // by default every requested placement is live on the corner: echo
        // back exactly the ids the service asked for.
        findMany: jest.fn().mockImplementation(async ({ where }: any) => {
          const requestedIds: number[] = where.id.in;
          return requestedIds.map((id) => ({ id }));
        }),
      },
      order: {
        create: jest.fn().mockResolvedValue({ id: orderId, orderItems: [] }),
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: orderId, deletedAt: null, orderItems: [] }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: orderId }),
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
    service = new OrdersService(prisma, corners as any);
  });

  it('create checks corner authority, validates items, and writes order + items', async () => {
    await service.create(owner, cornerId, createDto as any);

    expect(corners.assertWorksCorner).toHaveBeenCalledWith(owner, cornerId);
    expect(prisma.companyStoreProduct.findMany).toHaveBeenCalledWith({
      where: { id: { in: [7, 8] }, companyStoreId: cornerId, deletedAt: null },
      select: { id: true },
    });
    const arg = prisma.order.create.mock.calls[0][0];
    expect(arg.data).toEqual(
      expect.objectContaining({
        companyStoreId: cornerId,
        title: 'Weekend restock',
        createdByUserId: 'owner-1',
      }),
    );
    expect(arg.data.orderItems.create).toHaveLength(2);
    expect(arg.include).toEqual({ orderItems: true });
  });

  it('create rejects a duplicate placement in the payload (400)', async () => {
    await expect(
      service.create(owner, cornerId, {
        ...createDto,
        items: [
          { companyStoreProductId: 7, productOrderQuantity: 1 },
          { companyStoreProductId: 7, productOrderQuantity: 2 },
        ],
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('create rejects a line that is not a live placement on this corner (400)', async () => {
    prisma.companyStoreProduct.findMany.mockResolvedValue([{ id: 7 }]); // only one of two
    await expect(
      service.create(owner, cornerId, createDto as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('findAll reads through the corner, filters soft-deleted, newest-first', async () => {
    await service.findAll(owner, cornerId);

    expect(corners.findOne).toHaveBeenCalledWith(owner, cornerId);
    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { companyStoreId: cornerId, deletedAt: null },
      include: { orderItems: true },
      orderBy: { orderDate: 'desc' },
    });
  });

  it('findOne 404s an absent/soft-deleted order', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    await expect(
      service.findOne(owner, cornerId, orderId),
    ).rejects.toThrow(NotFoundException);
  });

  it('update swaps the item set inside a transaction', async () => {
    await service.update(owner, cornerId, orderId, {
      title: 'Revised',
      items: [{ companyStoreProductId: 7, productOrderQuantity: 5 }],
    } as any);

    expect(corners.assertWorksCorner).toHaveBeenCalledWith(owner, cornerId);
    expect(transaction.order.update).toHaveBeenCalledWith({
      where: { id_companyStoreId: { id: orderId, companyStoreId: cornerId } },
      data: { title: 'Revised' },
    });
    expect(transaction.orderItem.deleteMany).toHaveBeenCalledWith({
      where: { orderId: orderId, companyStoreId: cornerId },
    });
    expect(transaction.orderItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          orderId: orderId,
          companyStoreId: cornerId,
          companyStoreProductId: 7,
          productOrderQuantity: 5,
        },
      ],
    });
  });

  it('update with no items touches the header only (no item swap)', async () => {
    await service.update(owner, cornerId, orderId, {
      title: 'Header only',
    } as any);

    expect(transaction.order.update).toHaveBeenCalled();
    expect(transaction.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(transaction.orderItem.createMany).not.toHaveBeenCalled();
  });

  it('remove soft-deletes with the caller stamped', async () => {
    await service.remove(owner, cornerId, orderId);

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id_companyStoreId: { id: orderId, companyStoreId: cornerId } },
      data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
    });
  });
});
