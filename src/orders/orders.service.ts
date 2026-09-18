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
}
