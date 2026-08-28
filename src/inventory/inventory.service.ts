import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryTransactionType,
  TransactionSourceType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { EFFECTS } from './inventory-effects';
import { Prisma } from '../generated/prisma/client';

type Source = { type: TransactionSourceType; id: string };

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
  ) {}

  async record(
    caller: AuthUser,
    cornerId: string,
    placementId: number,
    dto: CreateTransactionDto,
    source?: Source,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const placement = await this.prisma.companyStoreProduct.findFirst({
      where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
    });
    if (!placement) throw new NotFoundException('Placement not found');

    return this.prisma.$transaction((tx) =>
      this.recordWithinTransaction(tx, placementId, dto, caller.id, source),
    );
  }

  // The atomic stock write + ledger append, runnable inside any caller-provided
  // transaction. Does NOT check corner authority or placement existence — the
  // caller (record, or an audit apply) is responsible for those.
  async recordWithinTransaction(
    tx: Prisma.TransactionClient,
    placementId: number,
    dto: {
      transactionType: InventoryTransactionType;
      quantity: number;
      remarks?: string;
    },
    callerId: string,
    source?: Source,
  ) {
    const effect = EFFECTS[dto.transactionType];
    const q = dto.quantity;
    if (effect.kind !== 'set' && q < 1)
      throw new BadRequestException('Quantity must be at least 1');

    const stock = await tx.companyStoreProductStock.findUnique({
      where: { companyStoreProductId: placementId },
    });
    if (!stock) throw new NotFoundException('Stock not found');

    let quantityBefore: number;
    let quantityAfter: number;

    if (effect.kind === 'set') {
      quantityBefore = stock.availableQuantity;
      quantityAfter = q;

      await tx.companyStoreProductStock.update({
        where: { companyStoreProductId: placementId },
        data: { availableQuantity: q },
      });
    } else {
      quantityBefore = stock[effect.primaryBucket];
      for (const { field, sign } of effect.deltas) {
        if (sign === -1) {
          const { count } = await tx.companyStoreProductStock.updateMany({
            where: {
              companyStoreProductId: placementId,
              [field]: { gte: q },
            },
            data: { [field]: { decrement: q } },
          });
          if (count === 0) throw new ConflictException('Insufficient stock');
        } else {
          await tx.companyStoreProductStock.update({
            where: { companyStoreProductId: placementId },
            data: { [field]: { increment: q } },
          });
        }
      }
      const primarySign = effect.deltas.find(
        (delta) => delta.field === effect.primaryBucket,
      )?.sign;
      if (primarySign === undefined) {
        throw new InternalServerErrorException(
          `Inventory effect misconfigured: primaryBucket "${effect.primaryBucket}" is not among the deltas for ${dto.transactionType}`,
        );
      }
      quantityAfter = quantityBefore + primarySign * q;
    }

    return tx.inventoryTransaction.create({
      data: {
        companyStoreProductId: placementId,
        transactionType: dto.transactionType,
        quantity: q,
        quantityBefore: quantityBefore,
        quantityAfter: quantityAfter,
        remarks: dto.remarks ?? null,
        createdByUserId: callerId,
        sourceType: source?.type ?? null,
        sourceId: source?.id ?? null,
      },
    });
  }

  async findForPlacement(
    caller: AuthUser,
    cornerId: string,
    placementId: number,
  ) {
    await this.corners.findOne(caller, cornerId);
    const placement = await this.prisma.companyStoreProduct.findFirst({
      where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
    });
    if (!placement) throw new NotFoundException('Placement not found');
    return this.prisma.inventoryTransaction.findMany({
      where: { companyStoreProductId: placementId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
