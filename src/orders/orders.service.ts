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

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
  ) {}

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
            companyStoreId: cornerId,
            companyStoreProductId: orderItem.companyStoreProductId,
            productOrderQuantity: orderItem.productOrderQuantity,
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
}
