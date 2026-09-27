import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryTransactionType,
  ReservationStatus,
  TransactionSourceType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { InventoryService } from '../inventory/inventory.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { CancelReservationDto } from './dto/cancel-reservation.dto';
import { ListReservationsQueryDto } from './dto/list-reservations.query.dto';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
    private readonly inventory: InventoryService,
  ) {}

  private async getPlacement(cornerId: string, placementId: number) {
    const placement = await this.prisma.companyStoreProduct.findFirst({
      where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
    });
    if (!placement) throw new NotFoundException('Placement not found');
    return placement;
  }

  private async getReservation(cornerId: string, reservationId: string) {
    const reservation = await this.prisma.purchaseReservation.findFirst({
      where: { id: reservationId, companyStoreId: cornerId },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }

  async create(caller: AuthUser, cornerId: string, dto: CreateReservationDto) {
    await this.corners.assertWorksCorner(caller, cornerId);
    await this.getPlacement(cornerId, dto.companyStoreProductId);

    const { reservation, stockChanges } = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.purchaseReservation.create({
          data: {
            companyStoreProductId: dto.companyStoreProductId,
            companyStoreId: cornerId,
            reservedByName: dto.reservedByName,
            reservedByPhone: dto.reservedByPhone ?? null,
            reservedQuantity: dto.reservedQuantity,
            status: ReservationStatus.RESERVED,
            remark: dto.remark ?? null,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
            createdByUserId: caller.id,
          },
        });

        const { stockChange } = await this.inventory.recordWithinTransaction(
          tx,
          dto.companyStoreProductId,
          {
            transactionType: InventoryTransactionType.RESERVATION_HOLD,
            quantity: dto.reservedQuantity,
          },
          caller.id,
          { type: TransactionSourceType.RESERVATION, id: created.id },
        );

        return { reservation: created, stockChanges: [stockChange] };
      },
    );

    this.inventory.emitStockAlerts(stockChanges); // HOLD lowers available stock
    return reservation;
  }

  async findAll(
    caller: AuthUser,
    cornerId: string,
    query: ListReservationsQueryDto,
  ) {
    await this.corners.findOne(caller, cornerId);
    return this.prisma.purchaseReservation.findMany({
      where: {
        companyStoreId: cornerId,
        ...(query.companyStoreProductId !== undefined
          ? { companyStoreProductId: query.companyStoreProductId }
          : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      orderBy: { reservedAt: 'desc' },
    });
  }

  async findOne(caller: AuthUser, cornerId: string, reservationId: string) {
    await this.corners.findOne(caller, cornerId);
    return this.getReservation(cornerId, reservationId);
  }

  async fulfill(caller: AuthUser, cornerId: string, reservationId: string) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const reservation = await this.getReservation(cornerId, reservationId);
    if (reservation.status !== ReservationStatus.RESERVED)
      throw new ConflictException('Reservation is not active');

    const { fulfilled, stockChanges } = await this.prisma.$transaction(
      async (tx) => {
        const release = await this.inventory.recordWithinTransaction(
          tx,
          reservation.companyStoreProductId,
          {
            transactionType: InventoryTransactionType.RESERVATION_RELEASE,
            quantity: reservation.reservedQuantity,
          },
          caller.id,
          { type: TransactionSourceType.RESERVATION, id: reservation.id },
        );
        const sale = await this.inventory.recordWithinTransaction(
          tx,
          reservation.companyStoreProductId,
          {
            transactionType: InventoryTransactionType.SALE,
            quantity: reservation.reservedQuantity,
          },
          caller.id,
          { type: TransactionSourceType.RESERVATION, id: reservation.id },
        );
        const updated = await tx.purchaseReservation.update({
          where: { id: reservationId },
          data: {
            status: ReservationStatus.FULFILLED,
            fulfilledAt: new Date(),
          },
        });
        // both reports together, so stockAlertsFrom can see the net effect
        return {
          fulfilled: updated,
          stockChanges: [release.stockChange, sale.stockChange],
        };
      },
    );

    this.inventory.emitStockAlerts(stockChanges);
    return fulfilled;
  }

  async cancel(
    caller: AuthUser,
    cornerId: string,
    reservationId: string,
    dto: CancelReservationDto,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const reservation = await this.getReservation(cornerId, reservationId);
    if (reservation.status !== ReservationStatus.RESERVED)
      throw new ConflictException('Reservation is not active');

    return this.prisma.$transaction(async (tx) => {
      // RELEASE only raises available stock, so it can never cross below
      // target — no stock alert to collect.
      await this.inventory.recordWithinTransaction(
        tx,
        reservation.companyStoreProductId,
        {
          transactionType: InventoryTransactionType.RESERVATION_RELEASE,
          quantity: reservation.reservedQuantity,
        },
        caller.id,
        { type: TransactionSourceType.RESERVATION, id: reservation.id },
      );
      return tx.purchaseReservation.update({
        where: { id: reservationId },
        data: {
          status: ReservationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: dto.cancelReason ?? null,
        },
      });
    });
  }
}
