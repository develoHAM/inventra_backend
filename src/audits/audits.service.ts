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

@Injectable()
export class AuditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
    private readonly inventory: InventoryService,
  ) {}

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
}
