import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { MembershipChangeReason } from '../generated/prisma/enums';
import { OwnershipService } from '../authorization/ownership.service';
import { StoresService } from '../stores/stores.service';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import { NotificationEvent } from '../notifications/notification-events';
import type { MemberMovedEvent } from '../notifications/notification-events';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateCornerDto } from './dto/create-corner.dto';
import { UpdateCornerDto } from './dto/update-corner.dto';
import { HistoryQueryDto } from '../membership-history/dto/history-query.dto';
import type { MembershipHistoryPage } from '../membership-history/membership-change-view';

@Injectable()
export class CornersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly stores: StoresService,
    private readonly history: MembershipHistoryService,
    private readonly eventEmitter: EventEmitter2,
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
    const companyId = this.ownership.resolveTargetCompany(caller, requested);

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

  /**
   * A branch's history, newest first: everyone who arrived, left, or changed
   * role while in it. For the admin, owners, and the branch's own managers.
   */
  async listHistory(
    caller: AuthUser,
    cornerId: string,
    query: HistoryQueryDto,
  ): Promise<MembershipHistoryPage> {
    const corner = await this.findOne(caller, cornerId); // company-scoped → 404
    const isAdminOrOwner =
      caller.roleCode === 'ADMIN' || caller.roleCode === 'OWNER';
    const managesThisBranch =
      caller.roleCode === 'MANAGER' && caller.companyStoreId === corner.id;
    if (!isAdminOrOwner && !managesThisBranch)
      throw new ForbiddenException(
        "Only the owners and this branch's managers can read its history",
      );

    // Departures and arrivals: a move from A to B shows in both branches,
    // and a promotion inside A (stored "from A to A") shows in A.
    return this.history.page(
      {
        OR: [
          { fromCompanyStoreId: corner.id },
          { toCompanyStoreId: corner.id },
        ],
      },
      query,
    );
  }

  async update(caller: AuthUser, id: string, dto: UpdateCornerDto) {
    await this.findOne(caller, id);
    return this.prisma.companyStore.update({ where: { id: id }, data: dto });
  }

  /**
   * Soft-delete a branch and move everyone in it to "no branch", with a
   * history row and a notification each. A soft delete is an UPDATE, so no
   * foreign key clears the members for us: we do it in the same transaction.
   */
  async remove(caller: AuthUser, id: string) {
    const corner = await this.findOne(caller, id); // company-scoped → 404

    const released = await this.prisma.$transaction(async (transaction) => {
      // The guarded soft delete: a second delete finds deletedAt already set
      // (count 0 → 404), and writing the row locks it, so moves and approvals
      // into this branch wait and then see it deleted.
      const deleted = await transaction.companyStore.updateMany({
        where: { id: id, deletedAt: null },
        data: { deletedAt: new Date(), deletedByUserId: caller.id },
      });
      if (deleted.count === 0) throw new NotFoundException('Corner not found');

      // One statement clears the branch AND reports exactly who it changed,
      // so the history and the notifications can't include someone who was
      // moved out a moment earlier.
      const releasedMembers = await transaction.user.updateManyAndReturn({
        where: { companyStoreId: id, deletedAt: null },
        data: { companyStoreId: null },
        select: { id: true, roleId: true },
      });

      await this.history.record(
        transaction,
        releasedMembers.map((member) => ({
          companyId: corner.companyId,
          userId: member.id,
          reason: MembershipChangeReason.BRANCH_DELETED,
          fromRoleId: member.roleId,
          toRoleId: member.roleId,
          fromCornerId: id,
          toCornerId: null,
          changedByUserId: caller.id,
        })),
      );
      return releasedMembers;
    });

    for (const member of released) {
      const event: MemberMovedEvent = {
        memberUserId: member.id,
        changedByUserId: caller.id,
        fromCornerId: id,
        toCornerId: null,
        reason: 'BRANCH_DELETED',
      };
      this.eventEmitter.emit(NotificationEvent.MEMBER_MOVED, event);
    }

    return this.prisma.companyStore.findUniqueOrThrow({ where: { id: id } });
  }
}
