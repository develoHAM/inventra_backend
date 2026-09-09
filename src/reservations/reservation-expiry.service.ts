import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  InventoryTransactionType,
  ReservationStatus,
  TransactionSourceType,
} from '../generated/prisma/enums';

@Injectable()
export class ReservationExpiryService {
  private readonly logger = new Logger(ReservationExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  // Runs every minute. Releases RESERVED holds whose expiresAt has passed:
  // reserved -> available (RESERVATION_RELEASE), status -> EXPIRED. Each
  // reservation is claimed and released in its own transaction, so one bad
  // row never stalls the rest.
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepExpired() {
    const now = new Date();
    const due = await this.prisma.purchaseReservation.findMany({
      where: {
        status: ReservationStatus.RESERVED,
        expiresAt: { not: null, lte: now },
      },
      select: {
        id: true,
        companyStoreProductId: true,
        reservedQuantity: true,
        createdByUserId: true,
      },
    });

    let releasedCount = 0;
    for (const reservation of due) {
      try {
        const released = await this.prisma.$transaction(async (tx) => {
          // Guarded claim: only one execution flips RESERVED -> EXPIRED, so a
          // concurrent sweep / fulfill / cancel loses cleanly (count === 0).
          const { count } = await tx.purchaseReservation.updateMany({
            where: { id: reservation.id, status: ReservationStatus.RESERVED },
            data: { status: ReservationStatus.EXPIRED, expiredAt: now },
          });
          if (count === 0) return false;

          await this.inventory.recordWithinTransaction(
            tx,
            reservation.companyStoreProductId,
            {
              transactionType: InventoryTransactionType.RESERVATION_RELEASE,
              quantity: reservation.reservedQuantity,
            },
            reservation.createdByUserId, // actor: the reservation's creator
            { type: TransactionSourceType.RESERVATION, id: reservation.id },
          );
          return true;
        });
        if (released) releasedCount += 1;
      } catch (error) {
        this.logger.error(
          `Failed to expire reservation ${reservation.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    if (releasedCount > 0) {
      this.logger.log(`Auto-expired ${releasedCount} reservation(s)`);
    }
    return { releasedCount: releasedCount };
  }
}
