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
import type { AuthProfile } from '../auth/types/auth-profile';
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
   * May the caller work in this corner? Owners and the admin anywhere in
   * scope; everyone else only in a branch they work in (`caller.branchIds`,
   * reloaded from the database on every request). Managers and staff pass
   * the same check: what differs between them is what permissions allow.
   */
  async assertWorksCorner(caller: AuthProfile, cornerId: string) {
    const corner = await this.findOne(caller, cornerId); // company-scoped → 404
    const worksAcrossCompany =
      caller.roleCode === 'OWNER' || caller.roleCode === 'ADMIN';
    if (!worksAcrossCompany && !caller.branchIds.includes(cornerId)) {
      throw new ForbiddenException('You can only work in your own branches');
    }
    return corner;
  }

  async create(caller: AuthProfile, dto: CreateCornerDto) {
    const { companyId: requested, ...data } = dto;
    const companyId = this.ownership.resolveTargetCompany(caller, requested);

    const store = await this.stores.findActive(data.storeId);
    if (!store) {
      throw new BadRequestException('Invalid store');
    }

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

  async findAll(caller: AuthProfile) {
    return this.prisma.companyStore.findMany({
      where: { ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
  }

  async findOne(caller: AuthProfile, id: string) {
    const corner = await this.prisma.companyStore.findFirst({
      where: {
        id: id,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
    });
    if (!corner) {
      throw new NotFoundException('Corner not found');
    }
    return corner;
  }

  /**
   * A branch's history, newest first: everyone who arrived, left, or changed
   * role while in it. For the admin, owners, and the managers who work there.
   */
  async listHistory(
    caller: AuthProfile,
    cornerId: string,
    query: HistoryQueryDto,
  ): Promise<MembershipHistoryPage> {
    const corner = await this.findOne(caller, cornerId); // company-scoped → 404
    const isAdminOrOwner =
      caller.roleCode === 'ADMIN' || caller.roleCode === 'OWNER';
    const managesThisBranch =
      caller.roleCode === 'MANAGER' && caller.branchIds.includes(corner.id);
    if (!isAdminOrOwner && !managesThisBranch) {
      throw new ForbiddenException(
        "Only the owners and this branch's managers can read its history",
      );
    }

    // Arrivals and departures: rows where the branch is the "from" or the
    // "to". A promotion inside A (stored "from A to A") shows in A.
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

  async update(caller: AuthProfile, id: string, dto: UpdateCornerDto) {
    await this.findOne(caller, id);
    return this.prisma.companyStore.update({ where: { id: id }, data: dto });
  }

  /**
   * Soft-delete a branch and end every assignment to it, with a history
   * row and a notification each. Never blocked by the people in it, and
   * nobody's role changes: someone whose only branch this was keeps their
   * role and waits for an owner to add them to another. A soft delete is an
   * UPDATE, so no foreign key ends the assignments for us: we do it in the
   * same transaction.
   */
  async remove(caller: AuthProfile, id: string) {
    const corner = await this.findOne(caller, id); // company-scoped → 404

    const released = await this.prisma.$transaction(async (transaction) => {
      // The guarded soft delete: a second delete finds deletedAt already set
      // (count 0 → 404), and writing the row locks it, so additions and
      // approvals into this branch wait and then see it deleted.
      const deleted = await transaction.companyStore.updateMany({
        where: { id: id, deletedAt: null },
        data: { deletedAt: new Date(), deletedByProfileId: caller.id },
      });
      if (deleted.count === 0) {
        throw new NotFoundException('Corner not found');
      }

      // One statement ends the assignments AND reports exactly which it
      // ended, so the history and the notifications can't include someone
      // removed from this branch a moment earlier.
      const endedAssignments =
        await transaction.profileBranch.updateManyAndReturn({
          where: { companyStoreId: id, deletedAt: null },
          data: { deletedAt: new Date(), deletedByProfileId: caller.id },
          select: { profileId: true },
        });

      // History rows are full snapshots: each names the person's role,
      // which this doesn't change. One read for all of them.
      const people = await transaction.profile.findMany({
        where: {
          id: {
            in: endedAssignments.map((assignment) => assignment.profileId),
          },
        },
        select: { id: true, roleId: true },
      });
      const roleIdOf = new Map(
        people.map((person) => [person.id, person.roleId]),
      );

      await this.history.record(
        transaction,
        endedAssignments.map((assignment) => ({
          companyId: corner.companyId,
          profileId: assignment.profileId,
          reason: MembershipChangeReason.BRANCH_DELETED,
          fromRoleId: roleIdOf.get(assignment.profileId) ?? null,
          toRoleId: roleIdOf.get(assignment.profileId) ?? null,
          fromCornerId: id,
          toCornerId: null,
          changedByProfileId: caller.id,
        })),
      );
      return endedAssignments;
    });

    for (const assignment of released) {
      const event: MemberMovedEvent = {
        memberProfileId: assignment.profileId,
        changedByProfileId: caller.id,
        cornerId: id,
        change: 'BRANCH_DELETED',
      };
      this.eventEmitter.emit(NotificationEvent.MEMBER_MOVED, event);
    }

    return this.prisma.companyStore.findUniqueOrThrow({ where: { id: id } });
  }
}
