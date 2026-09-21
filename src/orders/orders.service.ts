import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { OrderItemDto } from './dto/order-item.dto';
import { AuthUser } from '../auth/types/auth-user';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { SpreadsheetService } from '../spreadsheet/spreadsheet.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
    private readonly spreadsheet: SpreadsheetService,
  ) {}

  private readonly ORDER_EXPORT_COLUMNS = [
    { key: 'orderId', label: { en: 'Order ID', ko: '주문 ID' } },
    { key: 'title', label: { en: 'Title', ko: '제목' } },
    { key: 'description', label: { en: 'Description', ko: '설명' } },
    { key: 'orderDate', label: { en: 'Order Date', ko: '주문일자' } },
    { key: 'userName', label: { en: 'Created By', ko: '작성자' } },
    { key: 'createdAt', label: { en: 'Created At', ko: '생성일시' } },
    { key: 'companyStoreName', label: { en: 'Corner', ko: '코너' } },
    { key: 'productBarcode', label: { en: 'Barcode', ko: '바코드' } },
    { key: 'productName', label: { en: 'Product', ko: '상품명' } },
    {
      key: 'productOrderQuantity',
      label: { en: 'Order Quantity', ko: '주문 수량' },
    },
  ];

  private orderColIndex(key: string): number {
    return this.ORDER_EXPORT_COLUMNS.findIndex((column) => column.key === key);
  }

  private async buildOrderDtoFromFile(
    cornerId: string,
    file: Express.Multer.File,
  ): Promise<CreateOrderDto> {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    const format = ext === 'csv' ? 'csv' : ext === 'xlsx' ? 'xlsx' : null;
    if (!format) throw new BadRequestException('File must be .csv or .xlsx');

    const rows = await this.spreadsheet.parse(format, file.buffer);
    if (rows.length === 0) throw new BadRequestException('The file is empty');
    if (rows[0].length !== this.ORDER_EXPORT_COLUMNS.length)
      throw new BadRequestException('Unexpected column layout');
    const dataRows = rows.slice(1);
    if (dataRows.length === 0)
      throw new BadRequestException('The file has no data rows');

    const titleIdx = this.orderColIndex('title');
    const descIdx = this.orderColIndex('description');
    const dateIdx = this.orderColIndex('orderDate');
    const barcodeIdx = this.orderColIndex('productBarcode');
    const qtyIdx = this.orderColIndex('productOrderQuantity');

    const errors: { row: number; error: string }[] = [];

    const title = (dataRows[0][titleIdx] ?? '').trim();
    if (!title) errors.push({ row: 2, error: 'Title is required' });
    else if (title.length > 255)
      errors.push({ row: 2, error: 'Title exceeds 255 characters' });
    const descriptionRaw = (dataRows[0][descIdx] ?? '').trim();
    const orderDate = (dataRows[0][dateIdx] ?? '').trim();
    if (!orderDate || Number.isNaN(Date.parse(orderDate)))
      errors.push({ row: 2, error: 'Invalid order date' });

    // one file = one order: every later data row must repeat the same header cells
    dataRows.slice(1).forEach((dataRow, index) => {
      const line = index + 3; // rows 3..N (first data row was line 2)
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
      if ((dataRow[dateIdx] ?? '').trim() !== orderDate)
        errors.push({
          row: line,
          error: 'Order Date differs from the first data row',
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
    const items: {
      companyStoreProductId: number;
      productOrderQuantity: number;
    }[] = [];

    dataRows.forEach((dataRow, index) => {
      const line = index + 2; // sheet line (header is line 1)
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
      if (!Number.isInteger(quantity) || quantity < 1) {
        errors.push({ row: line, error: 'Quantity must be an integer ≥ 1' });
        return;
      }
      items.push({
        companyStoreProductId: placementId,
        productOrderQuantity: quantity,
      });
    });

    if (errors.length > 0)
      throw new BadRequestException({
        message: 'Import failed',
        errors: errors,
      });

    const dto: CreateOrderDto = {
      title: title,
      orderDate: orderDate,
      items: items,
    } as CreateOrderDto;
    if (descriptionRaw) dto.description = descriptionRaw;
    return dto;
  }

  private async validateItems(cornerId: string, items: OrderItemDto[]) {
    const placementIds = items.map((item) => item.companyStoreProductId);
    const uniquePlacementIds = new Set(placementIds);
    if (uniquePlacementIds.size !== placementIds.length)
      throw new BadRequestException('Duplicate product in order items');

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

  private async getOrder(cornerId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, companyStoreId: cornerId, deletedAt: null },
      include: { orderItems: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async create(caller: AuthUser, cornerId: string, dto: CreateOrderDto) {
    const { items: orderItems, title, description, fileUrl, orderDate } = dto;

    await this.corners.assertWorksCorner(caller, cornerId);
    await this.validateItems(cornerId, dto.items);

    return this.prisma.order.create({
      data: {
        companyStoreId: cornerId,
        title: title,
        description: description ?? null,
        fileUrl: fileUrl ?? null,
        orderDate: new Date(orderDate),
        createdByUserId: caller.id,
        orderItems: {
          create: orderItems.map((orderItem) => ({
            productOrderQuantity: orderItem.productOrderQuantity,
            companyStoreProduct: {
              connect: {
                id_companyStoreId: {
                  id: orderItem.companyStoreProductId,
                  companyStoreId: cornerId,
                },
              },
            },
          })),
        },
      },
      include: { orderItems: true },
    });
  }

  async findAll(caller: AuthUser, cornerId: string) {
    await this.corners.findOne(caller, cornerId);
    return this.prisma.order.findMany({
      where: { companyStoreId: cornerId, deletedAt: null },
      include: { orderItems: true },
      orderBy: { orderDate: 'desc' },
    });
  }

  async findOne(caller: AuthUser, cornerId: string, orderId: string) {
    await this.corners.findOne(caller, cornerId);
    return this.getOrder(cornerId, orderId);
  }

  async update(
    caller: AuthUser,
    cornerId: string,
    orderId: string,
    dto: UpdateOrderDto,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    await this.getOrder(cornerId, orderId);
    if (dto.items) await this.validateItems(cornerId, dto.items);

    return this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id_companyStoreId: { id: orderId, companyStoreId: cornerId } },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.fileUrl !== undefined ? { fileUrl: dto.fileUrl } : {}),
          ...(dto.orderDate !== undefined
            ? { orderDate: new Date(dto.orderDate) }
            : {}),
        },
      });

      if (dto.items) {
        await tx.orderItem.deleteMany({
          where: { orderId: orderId, companyStoreId: cornerId },
        });
        await tx.orderItem.createMany({
          data: dto.items.map((item) => ({
            orderId: orderId,
            companyStoreId: cornerId,
            companyStoreProductId: item.companyStoreProductId,
            productOrderQuantity: item.productOrderQuantity,
          })),
        });
      }
      return tx.order.findFirstOrThrow({
        where: { id: orderId, companyStoreId: cornerId },
        include: { orderItems: true },
      });
    });
  }

  async remove(caller: AuthUser, cornerId: string, orderId: string) {
    await this.corners.assertWorksCorner(caller, cornerId);
    await this.getOrder(cornerId, orderId);
    return this.prisma.order.update({
      where: { id_companyStoreId: { id: orderId, companyStoreId: cornerId } },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }

  async exportOrder(
    caller: AuthUser,
    cornerId: string,
    orderId: string,
    format: 'csv' | 'xlsx' = 'csv',
    lang: 'en' | 'ko' = 'en',
  ) {
    await this.corners.findOne(caller, cornerId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, companyStoreId: cornerId, deletedAt: null },
      include: {
        createdByUser: { select: { name: true } },
        companyStore: { select: { name: true } },
        orderItems: {
          include: {
            companyStoreProduct: {
              include: { product: { select: { barcode: true, name: true } } },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const rows = order.orderItems.map((item) => ({
      orderId: order.id,
      title: order.title,
      description: order.description ?? '',
      orderDate: order.orderDate.toISOString(),
      userName: order.createdByUser.name,
      createdAt: order.createdAt.toISOString(),
      companyStoreName: order.companyStore.name,
      productBarcode: item.companyStoreProduct.product.barcode,
      productName: item.companyStoreProduct.product.name,
      productOrderQuantity: item.productOrderQuantity,
    }));

    const columns = this.ORDER_EXPORT_COLUMNS.map((column) => ({
      header: column.label[lang],
      key: column.key,
    }));
    const buffer = await this.spreadsheet.toBuffer(format, columns, rows);
    return {
      buffer: buffer,
      filename: `order-${order.id}.${format}`,
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
    const dto = await this.buildOrderDtoFromFile(cornerId, file);
    return this.create(caller, cornerId, dto);
  }

  async importUpdate(
    caller: AuthUser,
    cornerId: string,
    orderId: string,
    file: Express.Multer.File,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const dto = await this.buildOrderDtoFromFile(cornerId, file);
    return this.update(caller, cornerId, orderId, dto);
  }
}
