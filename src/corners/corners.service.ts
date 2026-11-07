import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { OwnershipService } from '../authorization/ownership.service';
import { StoresService } from '../stores/stores.service';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateCornerDto } from './dto/create-corner.dto';
import { UpdateCornerDto } from './dto/update-corner.dto';

@Injectable()
export class CornersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly stores: StoresService,
  ) {}

  /**
   * May the caller work in this corner? Managers and staff only in their
   * own branch (`caller.companyStoreId`, reloaded from the database on every
   * request); owners and the admin anywhere in scope.
   */
  async assertWorksCorner(caller: AuthUser, cornerId: string) {
    const corner = await this.findOne(caller, cornerId); // company-scoped → 404
    if (caller.roleCode === 'MANAGER' && caller.companyStoreId !== cornerId)
      throw new ForbiddenException('You can only manage corners you manage');
    if (caller.roleCode === 'STAFF' && caller.companyStoreId !== cornerId)
      throw new ForbiddenException(
        'You can only manage the corner you are assigned to',
      );
    return corner;
  }

  async create(caller: AuthUser, dto: CreateCornerDto) {
    const { companyId: requested, ...data } = dto;
    const companyId = this.ownership.resolveCompanyForCreate(caller, requested);

    const store = await this.stores.findActive(data.storeId);
    if (!store) throw new BadRequestException('Invalid store');

    return this.prisma.companyStore.create({
      data: { ...data, companyId: companyId },
    });
  }

  /**
   * Inside a transaction: is this a live corner of that company? Answers by
   * writing the corner's row, which also takes the row's lock, so a delete
   * of the same corner waits for this transaction (and vice versa). The
   * caller decides what "false" means (404, usually).
   */
  async lockLiveCorner(
    transaction: Prisma.TransactionClient,
    cornerId: string,
    companyId: string,
  ): Promise<boolean> {
    const locked = await transaction.companyStore.updateMany({
      where: { id: cornerId, companyId: companyId, deletedAt: null },
      data: { updatedAt: new Date() },
    });
    return locked.count === 1;
  }

  async findAll(caller: AuthUser) {
    return this.prisma.companyStore.findMany({
      where: { ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
  }

  async findOne(caller: AuthUser, id: string) {
    const corner = await this.prisma.companyStore.findFirst({
      where: {
        id: id,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
    });
    if (!corner) throw new NotFoundException('Corner not found');
    return corner;
  }

  async update(caller: AuthUser, id: string, dto: UpdateCornerDto) {
    await this.findOne(caller, id);
    return this.prisma.companyStore.update({ where: { id: id }, data: dto });
  }

  async remove(caller: AuthUser, id: string) {
    await this.findOne(caller, id);
    return this.prisma.companyStore.update({
      where: { id: id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }
}
