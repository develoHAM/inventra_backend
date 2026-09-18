import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: any;
  let corners: { assertWorksCorner: jest.Mock; findOne: jest.Mock };
  let transaction: any;
  let spreadsheet: { toBuffer: jest.Mock };

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
          return requestedIds.map((id) => ({ id: id }));
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
    spreadsheet = {
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('bytes')),
    };
    service = new OrdersService(prisma, corners as any, spreadsheet as any);
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
    // items attach the placement by relation (companyStoreId is shared with
    // the parent order relation, so it can't be a raw scalar here)
    expect(arg.data.orderItems.create[0]).toEqual({
      productOrderQuantity: 10,
      companyStoreProduct: {
        connect: { id_companyStoreId: { id: 7, companyStoreId: cornerId } },
      },
    });
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
    await expect(service.findOne(owner, cornerId, orderId)).rejects.toThrow(
      NotFoundException,
    );
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

  describe('exportOrder', () => {
    const orderRecord = {
      id: orderId,
      title: 'Weekend restock',
      description: null,
      orderDate: new Date('2026-08-23T00:00:00.000Z'),
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      createdByUser: { name: 'Owner One' },
      companyStore: { name: 'Corner A' },
      orderItems: [
        {
          productOrderQuantity: 10,
          companyStoreProduct: { product: { barcode: 'BC-1', name: 'Widget' } },
        },
        {
          productOrderQuantity: 4,
          companyStoreProduct: { product: { barcode: 'BC-2', name: 'Gadget' } },
        },
      ],
    };

    it('scopes via the corner, builds one row per item (header repeated), EN headers + csv by default', async () => {
      prisma.order.findFirst.mockResolvedValue(orderRecord);

      const result = await service.exportOrder(owner, cornerId, orderId);

      expect(corners.findOne).toHaveBeenCalledWith(owner, cornerId);

      const [format, columns, rows] = spreadsheet.toBuffer.mock.calls[0];
      expect(format).toBe('csv');
      expect(columns).toHaveLength(10);
      expect(columns[0]).toEqual({ header: 'Order ID', key: 'orderId' });
      expect(columns[columns.length - 1]).toEqual({
        header: 'Order Quantity',
        key: 'productOrderQuantity',
      });

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        orderId: orderId,
        title: 'Weekend restock',
        description: '',
        orderDate: '2026-08-23T00:00:00.000Z',
        userName: 'Owner One',
        createdAt: '2026-08-20T00:00:00.000Z',
        companyStoreName: 'Corner A',
        productBarcode: 'BC-1',
        productName: 'Widget',
        productOrderQuantity: 10,
      });
      // header fields repeat on every item row
      expect(rows[1].orderId).toBe(orderId);
      expect(rows[1].title).toBe('Weekend restock');
      expect(rows[1].productBarcode).toBe('BC-2');
      expect(rows[1].productOrderQuantity).toBe(4);

      expect(result.filename).toBe(`order-${orderId}.csv`);
      expect(result.contentType).toBe('text/csv');
      expect(result.buffer).toEqual(Buffer.from('bytes'));
    });

    it('resolves Korean headers when lang=ko (keys stay stable)', async () => {
      prisma.order.findFirst.mockResolvedValue(orderRecord);

      await service.exportOrder(owner, cornerId, orderId, 'csv', 'ko');

      const columns = spreadsheet.toBuffer.mock.calls[0][1];
      expect(columns[0]).toEqual({ header: '주문 ID', key: 'orderId' });
      expect(columns[columns.length - 1]).toEqual({
        header: '주문 수량',
        key: 'productOrderQuantity',
      });
    });

    it('format=xlsx sets the xlsx filename + content-type', async () => {
      prisma.order.findFirst.mockResolvedValue(orderRecord);

      const result = await service.exportOrder(owner, cornerId, orderId, 'xlsx');

      expect(spreadsheet.toBuffer.mock.calls[0][0]).toBe('xlsx');
      expect(result.filename).toBe(`order-${orderId}.xlsx`);
      expect(result.contentType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    });

    it('404s an absent / cross-tenant order and generates nothing', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.exportOrder(owner, cornerId, orderId),
      ).rejects.toThrow(NotFoundException);
      expect(spreadsheet.toBuffer).not.toHaveBeenCalled();
    });
  });
});
