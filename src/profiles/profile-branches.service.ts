import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { CornersService } from '../corners/corners.service';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import type { AuthProfile } from '../auth/types/auth-profile';
import {
  MembershipChangeReason,
  ProfileStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';
import type { MemberMovedEvent } from '../notifications/notification-events';
import { ProfilesService } from './profiles.service';
import type { MemberRow, ProfileView } from './profile-view';
import { AddBranchDto } from './dto/add-branch.dto';

/**
 * Where a manager or staff member works: add them to a branch, or end one
 * of their assignments (even the last). Their role never changes here.
 */
@Injectable()
export class ProfileBranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly corners: CornersService,
    private readonly history: MembershipHistoryService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async add(
    caller: AuthProfile,
    profileId: string,
    dto: AddBranchDto,
  ): Promise<ProfileView> {
    this.assertCanAssign(caller);
    const target = await this.findTarget(caller, profileId);
    if (target.status !== ProfileStatus.ACTIVE)
      throw new BadRequestException('Only active members can be changed');
    if (target.roleCode === 'OWNER')
      throw new BadRequestException('Owners work across the whole company');

    await this.prisma.$transaction(async (transaction) => {
      // Locks in the usual order: the branch, then the member. The branch
      // lock makes a delete of this branch wait for us, or us for it.
      const isLive = await this.corners.lockLiveCorner(
        transaction,
        dto.cornerId,
        target.companyId,
      );
      if (!isLive) throw new NotFoundException('Branch not found');
      await this.lockMember(transaction, target);

      // One live row per person per branch (the partial unique index): if
      // they already work there, the insert is skipped, not thrown, and the
      // empty array that comes back is our 409.
      const started = await transaction.profileBranch.createManyAndReturn({
        data: [{ profileId: target.id, companyStoreId: dto.cornerId }],
        skipDuplicates: true,
        select: { id: true },
      });
      if (started.length === 0)
        throw new ConflictException('Already in this branch');

      await this.history.record(transaction, [
        {
          companyId: target.companyId,
          profileId: target.id,
          reason: MembershipChangeReason.BRANCH_ADDED,
          fromRoleId: target.roleId,
          toRoleId: target.roleId,
          fromCornerId: null,
          toCornerId: dto.cornerId,
          changedByProfileId: caller.id,
        },
      ]);
    });

    const event: MemberMovedEvent = {
      memberProfileId: target.id,
      changedByProfileId: caller.id,
      cornerId: dto.cornerId,
      change: 'ADDED',
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_MOVED, event);

    return this.profiles.viewOf(target.id);
  }

  async remove(
    caller: AuthProfile,
    profileId: string,
    cornerId: string,
  ): Promise<ProfileView> {
    this.assertCanAssign(caller);
    const target = await this.findTarget(caller, profileId);

    await this.prisma.$transaction(async (transaction) => {
      await this.lockMember(transaction, target);

      // deletedAt: null in the where is the guard: of two removals at
      // once, the second finds nothing live, gets [] back, and answers 404.
      const ended = await transaction.profileBranch.updateManyAndReturn({
        where: {
          profileId: target.id,
          companyStoreId: cornerId,
          deletedAt: null,
        },
        data: { deletedAt: new Date(), deletedByProfileId: caller.id },
        select: { id: true },
      });
      if (ended.length === 0) throw new NotFoundException('Not in this branch');

      await this.history.record(transaction, [
        {
          companyId: target.companyId,
          profileId: target.id,
          reason: MembershipChangeReason.BRANCH_REMOVED,
          fromRoleId: target.roleId,
          toRoleId: target.roleId,
          fromCornerId: cornerId,
          toCornerId: null,
          changedByProfileId: caller.id,
        },
      ]);
    });

    const event: MemberMovedEvent = {
      memberProfileId: target.id,
      changedByProfileId: caller.id,
      cornerId: cornerId,
      change: 'REMOVED',
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_MOVED, event);

    return this.profiles.viewOf(target.id);
  }

  /**
   * A guest list: only owners and the admin, even if someone else is given
   * profiles.move personally. Company-wide powers come from company-wide roles.
   */
  private assertCanAssign(caller: AuthProfile): void {
    if (caller.roleCode !== 'ADMIN' && caller.roleCode !== 'OWNER')
      throw new ForbiddenException(
        'Only an owner can change branch assignments',
      );
  }

  private async findTarget(
    caller: AuthProfile,
    profileId: string,
  ): Promise<MemberRow> {
    const target = await this.profiles.findMember(caller, profileId);
    if (!target) throw new NotFoundException('Member not found');
    return target;
  }

  /**
   * Write the member's row, only if they're still who we read. Writing it
   * takes the row's lock, so a role change of the same person runs before
   * or after this, never in between: an owner never ends up with an
   * assignment, and the history names the role they really had.
   */
  private async lockMember(
    transaction: Prisma.TransactionClient,
    target: MemberRow,
  ): Promise<void> {
    const locked = await transaction.profile.updateMany({
      where: {
        id: target.id,
        companyId: target.companyId,
        roleId: target.roleId,
        status: target.status,
        deletedAt: null,
      },
      data: { updatedAt: new Date() },
    });
    if (locked.count === 0)
      throw new ConflictException('This member was just changed; reload');
  }
}
