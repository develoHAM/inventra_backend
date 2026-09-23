import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { AuditItemDto } from './dto/audit-item.dto';
import { AuthUser } from '../auth/types/auth-user';
import { CreateAuditDto } from './dto/create-audit.dto';
import { UpdateAuditDto } from './dto/update-audit.dto';
import {
  InventoryTransactionType,
  TransactionSourceType,
} from '../generated/prisma/enums';
import { SpreadsheetService } from '../spreadsheet/spreadsheet.service';

@Injectable()
export class AuditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
    private readonly inventory: InventoryService,
    private readonly spreadsheet: SpreadsheetService,
  ) {}

  private readonly AUDIT_EXPORT_COLUMNS = [
    { key: 'auditId', label: { en: 'Audit ID', ko: '실사 ID' } },
    { key: 'title', label: { en: 'Title', ko: '제목' } },
    { key: 'description', label: { en: 'Description', ko: '설명' } },
    { key: 'auditedDate', label: { en: 'Audit Date', ko: '실사일자' } },
    { key: 'userName', label: { en: 'Created By', ko: '작성자' } },
    { key: 'createdAt', label: { en: 'Created At', ko: '생성일시' } },
    { key: 'appliedAt', label: { en: 'Applied At', ko: '적용일시' } },
    { key: 'companyStoreName', label: { en: 'Corner', ko: '코너' } },
    { key: 'productBarcode', label: { en: 'Barcode', ko: '바코드' } },
    { key: 'productName', label: { en: 'Product', ko: '상품명' } },
    {
      key: 'productQuantity',
      label: { en: 'Counted Quantity', ko: '실사 수량' },
    },
  ];

  private auditColIndex(key: string): number {
    return this.AUDIT_EXPORT_COLUMNS.findIndex((column) => column.key === key);
  }

  private async buildAuditDtoFromFile(
    cornerId: string,
    file: Express.Multer.File,
  ): Promise<CreateAuditDto> {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    const format = ext === 'csv' ? 'csv' : ext === 'xlsx' ? 'xlsx' : null;
    if (!format) throw new BadRequestException('File must be .csv or .xlsx');

    const rows = await this.spreadsheet.parse(format, file.buffer);
    if (rows.length === 0) throw new BadRequestException('The file is empty');
    if (rows[0].length !== this.AUDIT_EXPORT_COLUMNS.length)
      throw new BadRequestException('Unexpected column layout');
    const dataRows = rows.slice(1);
    if (dataRows.length === 0)
      throw new BadRequestException('The file has no data rows');

    const titleIdx = this.auditColIndex('title');
    const descIdx = this.auditColIndex('description');
    const dateIdx = this.auditColIndex('auditedDate');
    const barcodeIdx = this.auditColIndex('productBarcode');
    const qtyIdx = this.auditColIndex('productQuantity');

    const errors: { row: number; error: string }[] = [];

    const title = (dataRows[0][titleIdx] ?? '').trim();
    if (!title) errors.push({ row: 2, error: 'Title is required' });
    else if (title.length > 255)
      errors.push({ row: 2, error: 'Title exceeds 255 characters' });
    const descriptionRaw = (dataRows[0][descIdx] ?? '').trim();
    const auditedDate = (dataRows[0][dateIdx] ?? '').trim();
    if (!auditedDate || Number.isNaN(Date.parse(auditedDate)))
      errors.push({ row: 2, error: 'Invalid audit date' });

    // one file = one audit: every later data row must repeat the same header cells
    dataRows.slice(1).forEach((dataRow, index) => {
      const line = index + 3;
      if ((dataRow[titleIdx] ?? '').trim() !== title)
        errors.push({
          row: line,
          error: 'Title differs from the first data row',
        });
      if ((dataRow[descIdx] ?? '').trim() !== descriptionRaw)
        errors.push({
          row: line,
          error: 'Description differs from the first data row',
        });
      if ((dataRow[dateIdx] ?? '').trim() !== auditedDate)
        errors.push({
          row: line,
          error: 'Audit Date differs from the first data row',
        });
    });

    const barcodes = dataRows.map((dataRow) =>
      (dataRow[barcodeIdx] ?? '').trim(),
    );
    const products = await this.prisma.product.findMany({
      where: {
        barcode: { in: barcodes.filter((barcode) => barcode.length > 0) },
        deletedAt: null,
      },
      select: { id: true, barcode: true },
    });
    const productIdByBarcode = new Map(
      products.map((product) => [product.barcode, product.id]),
    );
    const placements = await this.prisma.companyStoreProduct.findMany({
      where: {
        companyStoreId: cornerId,
        productId: { in: products.map((product) => product.id) },
        deletedAt: null,
      },
      select: { id: true, productId: true },
    });
    const placementIdByProductId = new Map(
      placements.map((placement) => [placement.productId, placement.id]),
    );

    const seenBarcodes = new Set<string>();
    const items: { companyStoreProductId: number; productQuantity: number }[] =
      [];

    dataRows.forEach((dataRow, index) => {
      const line = index + 2;
      const barcode = (dataRow[barcodeIdx] ?? '').trim();
      const quantity = Number((dataRow[qtyIdx] ?? '').trim());

      if (!barcode) {
        errors.push({ row: line, error: 'Barcode is required' });
        return;
      }
      if (seenBarcodes.has(barcode)) {
        errors.push({ row: line, error: `Duplicate barcode "${barcode}"` });
        return;
      }
      seenBarcodes.add(barcode);

      const productId = productIdByBarcode.get(barcode);
      if (productId === undefined) {
        errors.push({ row: line, error: `Unknown barcode "${barcode}"` });
        return;
      }
      const placementId = placementIdByProductId.get(productId);
      if (placementId === undefined) {
        errors.push({
          row: line,
          error: `Barcode "${barcode}" is not placed on this corner`,
        });
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 0) {
        errors.push({ row: line, error: 'Quantity must be an integer ≥ 0' });
        return;
      }
      items.push({
        companyStoreProductId: placementId,
        productQuantity: quantity,
      });
    });

    if (errors.length > 0)
      throw new BadRequestException({
        message: 'Import failed',
        errors: errors,
      });

    const dto: CreateAuditDto = {
      title: title,
      auditedDate: auditedDate,
      items: items,
    } as CreateAuditDto;
    if (descriptionRaw) dto.description = descriptionRaw;
    return dto;
  }

  private async validateItems(
    cornerId: string,
    items: { companyStoreProductId: number }[],
  ) {
    const placementIds = items.map((item) => item.companyStoreProductId);
    const uniquePlacementIds = new Set(placementIds);
    if (uniquePlacementIds.size !== placementIds.length)
      throw new BadRequestException('Duplicate product in audit items');

    const livePlacements = await this.prisma.companyStoreProduct.findMany({
      where: {
        id: { in: [...uniquePlacementIds] },
        companyStoreId: cornerId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (livePlacements.length !== uniquePlacementIds.size)
      throw new BadRequestException(
        'One or more items are not placements on this corner',
      );
  }

  private async getAudit(cornerId: string, auditId: string) {
    const audit = await this.prisma.inventoryAudit.findFirst({
      where: { id: auditId, companyStoreId: cornerId, deletedAt: null },
      include: { inventoryAuditItems: true },
    });
    if (!audit) throw new NotFoundException('Audit not found');
    return audit;
  }

  async create(caller: AuthUser, cornerId: string, dto: CreateAuditDto) {
    await this.corners.assertWorksCorner(caller, cornerId);
    await this.validateItems(cornerId, dto.items);

    return this.prisma.inventoryAudit.create({
      data: {
        companyStoreId: cornerId,
        title: dto.title,
        description: dto.description ?? null,
        fileUrl: dto.fileUrl ?? null,
        auditedDate: new Date(dto.auditedDate),
        createdByUserId: caller.id,
        inventoryAuditItems: {
          create: dto.items.map((item) => ({
            productQuantity: item.productQuantity,
            companyStoreProduct: {
              connect: {
                id_companyStoreId: {
                  id: item.companyStoreProductId,
                  companyStoreId: cornerId,
                },
              },
            },
          })),
        },
      },
      include: {
        inventoryAuditItems: true,
      },
    });
  }

  async findAll(caller: AuthUser, cornerId: string) {
    await this.corners.findOne(caller, cornerId);
    return this.prisma.inventoryAudit.findMany({
      where: {
        companyStoreId: cornerId,
        deletedAt: null,
      },
      include: { inventoryAuditItems: true },
      orderBy: { auditedDate: 'desc' },
    });
  }

  async findOne(caller: AuthUser, cornerId: string, auditId: string) {
    await this.corners.findOne(caller, cornerId);
    return this.getAudit(cornerId, auditId);
  }

  async update(
    caller: AuthUser,
    cornerId: string,
    auditId: string,
    dto: UpdateAuditDto,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const audit = await this.getAudit(cornerId, auditId);
    if (audit.appliedAt) throw new ConflictException('Audit already applied');
    if (dto.items) await this.validateItems(cornerId, dto.items);

    return this.prisma.$transaction(async (tx) => {
      await tx.inventoryAudit.update({
        where: {
          id_companyStoreId: {
            id: auditId,
            companyStoreId: cornerId,
          },
        },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.fileUrl !== undefined ? { fileUrl: dto.fileUrl } : {}),
          ...(dto.auditedDate !== undefined
            ? { auditedDate: new Date(dto.auditedDate) }
            : {}),
        },
      });

      if (dto.items) {
        await tx.inventoryAuditItem.deleteMany({
          where: { inventoryAuditId: auditId, companyStoreId: cornerId },
        });
        await tx.inventoryAuditItem.createMany({
          data: dto.items.map((item) => ({
            inventoryAuditId: auditId,
            companyStoreId: cornerId,
            companyStoreProductId: item.companyStoreProductId,
            productQuantity: item.productQuantity,
          })),
        });
      }

      return tx.inventoryAudit.findFirstOrThrow({
        where: { id: auditId, companyStoreId: cornerId },
        include: { inventoryAuditItems: true },
      });
    });
  }

  async remove(caller: AuthUser, cornerId: string, auditId: string) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const audit = await this.getAudit(cornerId, auditId);
    if (audit.appliedAt) throw new ConflictException('Audit already applied');
    return this.prisma.inventoryAudit.update({
      where: { id_companyStoreId: { id: auditId, companyStoreId: cornerId } },
      data: {
        deletedAt: new Date(),
        deletedByUserId: caller.id,
      },
    });
  }

  async apply(caller: AuthUser, cornerId: string, auditId: string) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const audit = await this.getAudit(cornerId, auditId);
    if (audit.appliedAt) throw new ConflictException('Audit already applied');
    await this.validateItems(cornerId, audit.inventoryAuditItems);

    return this.prisma.$transaction(async (tx) => {
      for (const item of audit.inventoryAuditItems) {
        await this.inventory.recordWithinTransaction(
          tx,
          item.companyStoreProductId,
          {
            transactionType: InventoryTransactionType.ADJUSTMENT,
            quantity: item.productQuantity,
          },
          caller.id,
          { type: TransactionSourceType.AUDIT, id: audit.id },
        );
      }
      return tx.inventoryAudit.update({
        where: { id_companyStoreId: { id: auditId, companyStoreId: cornerId } },
        data: {
          appliedAt: new Date(),
          appliedByUserId: caller.id,
        },
        include: { inventoryAuditItems: true },
      });
    });
  }

  async exportAudit(
    caller: AuthUser,
    cornerId: string,
    auditId: string,
    format: 'csv' | 'xlsx' = 'csv',
    lang: 'en' | 'ko' = 'en',
  ) {
    await this.corners.findOne(caller, cornerId);
    const audit = await this.prisma.inventoryAudit.findFirst({
      where: { id: auditId, companyStoreId: cornerId, deletedAt: null },
      include: {
        createdByUser: { select: { name: true } },
        companyStore: { select: { name: true } },
        inventoryAuditItems: {
          include: {
            companyStoreProduct: {
              include: { product: { select: { barcode: true, name: true } } },
            },
          },
        },
      },
    });
    if (!audit) throw new NotFoundException('Audit not found');

    const rows = audit.inventoryAuditItems.map((item) => ({
      auditId: audit.id,
      title: audit.title,
      description: audit.description ?? '',
      auditedDate: audit.auditedDate.toISOString(),
      userName: audit.createdByUser.name,
      createdAt: audit.createdAt.toISOString(),
      appliedAt: audit.appliedAt ? audit.appliedAt.toISOString() : '',
      companyStoreName: audit.companyStore.name,
      productBarcode: item.companyStoreProduct.product.barcode,
      productName: item.companyStoreProduct.product.name,
      productQuantity: item.productQuantity,
    }));

    const columns = this.AUDIT_EXPORT_COLUMNS.map((column) => ({
      header: column.label[lang],
      key: column.key,
    }));
    const buffer = await this.spreadsheet.toBuffer(format, columns, rows);
    return {
      buffer: buffer,
      filename: `audit-${audit.id}.${format}`,
      contentType:
        format === 'csv'
          ? 'text/csv'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  async importCreate(
    caller: AuthUser,
    cornerId: string,
    file: Express.Multer.File,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const dto = await this.buildAuditDtoFromFile(cornerId, file);
    return this.create(caller, cornerId, dto);
  }

  async importUpdate(
    caller: AuthUser,
    cornerId: string,
    auditId: string,
    file: Express.Multer.File,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const dto = await this.buildAuditDtoFromFile(cornerId, file);
    return this.update(caller, cornerId, auditId, dto);
  }
}
