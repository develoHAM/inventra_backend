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
  let spreadsheet: { toBuffer: jest.Mock; parse: jest.Mock };

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
          return requestedIds.map((id) => ({ id: id }));
        }),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([]),
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
    inventory = {
      recordWithinTransaction: jest.fn().mockResolvedValue({ id: 1 }),
    };
    spreadsheet = {
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('bytes')),
      parse: jest.fn(),
    };
    service = new AuditsService(
      prisma,
      corners as any,
      inventory as any,
      spreadsheet as any,
    );
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
    await expect(service.findOne(owner, cornerId, auditId)).rejects.toThrow(
      NotFoundException,
    );
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

  describe('exportAudit', () => {
    const auditRecord = {
      id: auditId,
      title: 'Monthly count',
      description: null,
      auditedDate: new Date('2026-08-28T00:00:00.000Z'),
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
      appliedAt: null as Date | null,
      createdByUser: { name: 'Owner One' },
      companyStore: { name: 'Corner A' },
      inventoryAuditItems: [
        {
          productQuantity: 12,
          companyStoreProduct: { product: { barcode: 'BC-1', name: 'Widget' } },
        },
        {
          productQuantity: 0,
          companyStoreProduct: { product: { barcode: 'BC-2', name: 'Gadget' } },
        },
      ],
    };

    it('scopes via the corner, builds one row per item (header repeated), EN + csv, appliedAt empty when unapplied', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue(auditRecord);

      const result = await service.exportAudit(owner, cornerId, auditId);

      expect(corners.findOne).toHaveBeenCalledWith(owner, cornerId);

      const [format, columns, rows] = spreadsheet.toBuffer.mock.calls[0];
      expect(format).toBe('csv');
      expect(columns).toHaveLength(11);
      expect(columns[0]).toEqual({ header: 'Audit ID', key: 'auditId' });
      expect(columns[6]).toEqual({ header: 'Applied At', key: 'appliedAt' });
      expect(columns[columns.length - 1]).toEqual({
        header: 'Counted Quantity',
        key: 'productQuantity',
      });

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        auditId: auditId,
        title: 'Monthly count',
        description: '',
        auditedDate: '2026-08-28T00:00:00.000Z',
        userName: 'Owner One',
        createdAt: '2026-08-25T00:00:00.000Z',
        appliedAt: '',
        companyStoreName: 'Corner A',
        productBarcode: 'BC-1',
        productName: 'Widget',
        productQuantity: 12,
      });
      expect(rows[1].auditId).toBe(auditId);
      expect(rows[1].productBarcode).toBe('BC-2');
      expect(rows[1].productQuantity).toBe(0);

      expect(result.filename).toBe(`audit-${auditId}.csv`);
      expect(result.contentType).toBe('text/csv');
    });

    it('fills appliedAt (ISO) when the audit is applied', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue({
        ...auditRecord,
        appliedAt: new Date('2026-08-30T00:00:00.000Z'),
      });

      await service.exportAudit(owner, cornerId, auditId);

      const rows = spreadsheet.toBuffer.mock.calls[0][2];
      expect(rows[0].appliedAt).toBe('2026-08-30T00:00:00.000Z');
    });

    it('resolves Korean headers when lang=ko (keys stay stable)', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue(auditRecord);

      await service.exportAudit(owner, cornerId, auditId, 'csv', 'ko');

      const columns = spreadsheet.toBuffer.mock.calls[0][1];
      expect(columns[0]).toEqual({ header: '실사 ID', key: 'auditId' });
      expect(columns[6]).toEqual({ header: '적용일시', key: 'appliedAt' });
      expect(columns[columns.length - 1]).toEqual({
        header: '실사 수량',
        key: 'productQuantity',
      });
    });

    it('format=xlsx sets the xlsx filename + content-type', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue(auditRecord);

      const result = await service.exportAudit(owner, cornerId, auditId, 'xlsx');

      expect(spreadsheet.toBuffer.mock.calls[0][0]).toBe('xlsx');
      expect(result.filename).toBe(`audit-${auditId}.xlsx`);
      expect(result.contentType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    });

    it('404s an absent / cross-tenant audit and generates nothing', async () => {
      prisma.inventoryAudit.findFirst.mockResolvedValue(null);

      await expect(
        service.exportAudit(owner, cornerId, auditId),
      ).rejects.toThrow(NotFoundException);
      expect(spreadsheet.toBuffer).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    // 11-column layout (includes appliedAt, which import ignores)
    const headerRow = [
      'auditId',
      'title',
      'description',
      'auditedDate',
      'userName',
      'createdAt',
      'appliedAt',
      'companyStoreName',
      'productBarcode',
      'productName',
      'productQuantity',
    ];
    const auditRow = (
      barcode: string,
      qty: string,
      over: { title?: string; description?: string; auditedDate?: string } = {},
    ): string[] => [
      '', // auditId (ignored)
      over.title ?? 'Monthly count',
      over.description ?? 'Back room',
      over.auditedDate ?? '2026-08-28T00:00:00.000Z',
      '', // userName (ignored)
      '', // createdAt (ignored)
      '', // appliedAt (ignored)
      '', // companyStoreName (ignored)
      barcode,
      '', // productName (ignored)
      qty,
    ];
    const file = (name: string) =>
      ({ originalname: name, buffer: Buffer.from('x') }) as any;

    const resolvable = () => {
      prisma.product.findMany.mockResolvedValue([
        { id: 'p1', barcode: 'BC-1' },
        { id: 'p2', barcode: 'BC-2' },
      ]);
      prisma.companyStoreProduct.findMany.mockResolvedValue([
        { id: 41, productId: 'p1' },
        { id: 42, productId: 'p2' },
      ]);
    };

    it('importCreate resolves barcodes and calls create; quantity 0 is accepted', async () => {
      spreadsheet.parse.mockResolvedValue([
        headerRow,
        auditRow('BC-1', '12'),
        auditRow('BC-2', '0'),
      ]);
      resolvable();
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({ id: auditId } as any);

      await service.importCreate(owner, cornerId, file('a.csv'));

      expect(spreadsheet.parse).toHaveBeenCalledWith('csv', expect.any(Buffer));
      expect(createSpy).toHaveBeenCalledWith(owner, cornerId, {
        title: 'Monthly count',
        auditedDate: '2026-08-28T00:00:00.000Z',
        description: 'Back room',
        items: [
          { companyStoreProductId: 41, productQuantity: 12 },
          { companyStoreProductId: 42, productQuantity: 0 },
        ],
      });
    });

    it('collects row errors → 400, create not called', async () => {
      spreadsheet.parse.mockResolvedValue([
        headerRow,
        auditRow('ZZZ', '5'), // line 2: unknown barcode
        auditRow('BC-1', '-1'), // line 3: negative quantity
      ]);
      resolvable();
      const createSpy = jest.spyOn(service, 'create');

      expect.assertions(2);
      try {
        await service.importCreate(owner, cornerId, file('a.csv'));
      } catch (thrown) {
        const response = (thrown as BadRequestException).getResponse() as {
          errors: { row: number; error: string }[];
        };
        expect(response.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ row: 2, error: expect.stringContaining('Unknown barcode') }),
            expect.objectContaining({ row: 3, error: expect.stringContaining('Quantity') }),
          ]),
        );
      }
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('importUpdate onto an already-applied audit → 409', async () => {
      spreadsheet.parse.mockResolvedValue([headerRow, auditRow('BC-1', '5')]);
      resolvable();
      prisma.inventoryAudit.findFirst.mockResolvedValue({
        id: auditId,
        appliedAt: new Date(),
        inventoryAuditItems: [],
      });

      await expect(
        service.importUpdate(owner, cornerId, auditId, file('a.csv')),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a non-csv/xlsx extension (400)', async () => {
      await expect(
        service.importCreate(owner, cornerId, file('a.txt')),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
