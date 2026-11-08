import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { OwnershipService } from '../authorization/ownership.service';
import { CornersService } from '../corners/corners.service';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import { StorageService } from '../storage/storage.service';
import type { AuthUser } from '../auth/types/auth-user';
import { MembershipChangeReason, UserStatus } from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';
import type {
  MemberMovedEvent,
  MemberApprovedEvent,
  MemberRoleChangedEvent,
} from '../notifications/notification-events';
import { decideRoleChange, isMemberRole } from './member-rules';
import { MEMBER_SELECT } from './member-view';
import type { MemberRow, MemberView } from './member-view';
import { ChangeBranchDto } from './dto/change-branch.dto';
import { ApproveMemberDto } from './dto/approve-member.dto';
import { ChangeRoleDto } from './dto/change-role.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly corners: CornersService,
    private readonly history: MembershipHistoryService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Approve someone who joined with the company code, choosing their role
   * and branch in one step. Managers approve only as staff, into their own
   * branch.
   */
  async approve(
    caller: AuthUser,
    userId: string,
    dto: ApproveMemberDto,
  ): Promise<MemberView> {
    // A pending member has no role yet, so this is the plain scoped lookup
    // (findTarget would treat them as "not found").
    const target = await this.prisma.user.findFirst({
      where: {
        id: userId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: MEMBER_SELECT,
    });
    if (!target || target.companyId === null)
      throw new NotFoundException('Member not found');
    if (target.status !== UserStatus.PENDING_APPROVAL)
      throw new BadRequestException('Member is not pending approval');

    const role = await this.prisma.role.findUnique({
      where: {
        id: dto.roleId,
      },
    });
    if (!role || (role.code !== 'MANAGER' && role.code !== 'STAFF'))
      throw new BadRequestException('Invalid role for a member');

    if (caller.roleCode === 'MANAGER') {
      if (role.code !== 'STAFF')
        throw new ForbiddenException('Managers can approve only as staff');
      // A manager with no branch has null, and so does cornerId: null.
      // null === null must not count as "their own branch".
      const callerBranchId = caller.companyStoreId ?? null;
      const intoOwnBranch =
        callerBranchId !== null && dto.cornerId === callerBranchId;
      if (!intoOwnBranch)
        throw new ForbiddenException(
          'Managers can approve only into their own branch',
        );
    }

    const companyId = target.companyId;
    await this.prisma.$transaction(async (transaction) => {
      if (dto.cornerId !== null) {
        const isLive = await this.corners.lockLiveCorner(
          transaction,
          dto.cornerId,
          companyId,
        );
        if (!isLive) throw new NotFoundException('Branch not found');
      }

      // Still pending? If someone approved them a moment ago, nothing
      // matches and count is 0.
      const approved = await transaction.user.updateMany({
        where: {
          id: target.id,
          status: UserStatus.PENDING_APPROVAL,
          deletedAt: null,
        },
        data: {
          roleId: role.id,
          status: UserStatus.ACTIVE,
          companyStoreId: dto.cornerId,
        },
      });
      if (approved.count === 0)
        throw new ConflictException('This member was just changed; reload');

      await this.history.record(transaction, [
        {
          companyId: companyId,
          userId: target.id,
          reason: MembershipChangeReason.APPROVED,
          fromRoleId: target.roleId,
          toRoleId: role.id,
          fromCornerId: target.companyStoreId,
          toCornerId: dto.cornerId,
          changedByUserId: caller.id,
        },
      ]);
    });

    const event: MemberApprovedEvent = {
      memberUserId: target.id,
      approvedByUserId: caller.id,
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_APPROVED, event);

    return this.toView(await this.findRow(target.id));
  }

  /** Move a manager or staff member to another branch, or off theirs (null). */
  async changeBranch(
    caller: AuthUser,
    userId: string,
    dto: ChangeBranchDto,
  ): Promise<MemberView> {
    if (caller.roleCode !== 'ADMIN' && caller.roleCode !== 'OWNER')
      throw new ForbiddenException(
        'Only an owner can move members between branches',
      );

    const target = await this.findTarget(caller, userId);
    if (target.status !== UserStatus.ACTIVE)
      throw new BadRequestException('Only active members can be changed');
    if (target.roleCode !== 'MANAGER' && target.roleCode !== 'STAFF')
      throw new BadRequestException(
        'Only managers and staff belong to a branch',
      );
    if (target.companyStoreId === dto.cornerId) return this.toView(target);

    await this.prisma.$transaction(async (transaction) => {
      if (dto.cornerId !== null) {
        const isLive = await this.corners.lockLiveCorner(
          transaction,
          dto.cornerId,
          target.companyId,
        );
        if (!isLive) throw new NotFoundException('Branch not found');
      }

      // The where repeats what we read: if anyone changed this member in
      // between, nothing matches and count is 0.
      const moved = await transaction.user.updateMany({
        where: {
          id: target.id,
          companyId: target.companyId,
          roleId: target.roleId,
          companyStoreId: target.companyStoreId,
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        data: { companyStoreId: dto.cornerId },
      });
      if (moved.count === 0)
        throw new ConflictException('This member was just changed; reload');

      await this.history.record(transaction, [
        {
          companyId: target.companyId,
          userId: target.id,
          reason: MembershipChangeReason.MOVED,
          fromRoleId: target.roleId,
          toRoleId: target.roleId,
          fromCornerId: target.companyStoreId,
          toCornerId: dto.cornerId,
          changedByUserId: caller.id,
        },
      ]);
    });

    const event: MemberMovedEvent = {
      memberUserId: target.id,
      changedByUserId: caller.id,
      fromCornerId: target.companyStoreId,
      toCornerId: dto.cornerId,
      reason: 'MOVED',
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_MOVED, event);

    return this.toView(await this.findRow(target.id));
  }

  /**
   * Promote or demote a member, following decideRoleChange. Takes effect at
   * once; the person is notified.
   */
  async changeRole(
    caller: AuthUser,
    userId: string,
    dto: ChangeRoleDto,
  ): Promise<MemberView> {
    const target = await this.findTarget(caller, userId);
    if (target.status !== UserStatus.ACTIVE)
      throw new BadRequestException('Only active members can be changed');

    // "Not sent" (undefined) is not the same answer as null ("no branch").
    const cornerIdSent = dto.cornerId !== undefined;
    const decision = decideRoleChange({
      callerRole: caller.roleCode,
      callerBranchId: caller.companyStoreId ?? null,
      targetRole: target.roleCode,
      targetBranchId: target.companyStoreId,
      requestedRole: dto.role,
      cornerIdSent: cornerIdSent,
    });
    if (decision === 'noop') return this.toView(target);

    // Role ids differ between databases; the code is the stable name.
    const role = await this.prisma.role.findUniqueOrThrow({
      where: { code: dto.role },
    });
    const branchAfter =
      decision.branch === 'keep'
        ? target.companyStoreId
        : decision.branch === 'clear'
          ? null
          : (dto.cornerId ?? null);

    await this.prisma.$transaction(async (transaction) => {
      // Locks always in this order: company, then branch, then member.
      if (decision.checkOwnerCount) {
        // Every owner demotion writes the company row first, so two of them
        // run one after the other and the second counts what the first left.
        await transaction.company.updateMany({
          where: { id: target.companyId },
          data: { updatedAt: new Date() },
        });
        const activeOwners = await transaction.user.count({
          where: {
            companyId: target.companyId,
            role: { code: 'OWNER' },
            status: UserStatus.ACTIVE,
            deletedAt: null,
          },
        });
        if (activeOwners < 2)
          throw new ConflictException('A company needs at least one owner');
      }

      if (decision.branch === 'set' && branchAfter !== null) {
        const isLive = await this.corners.lockLiveCorner(
          transaction,
          branchAfter,
          target.companyId,
        );
        if (!isLive) throw new NotFoundException('Branch not found');
      }

      const changed = await transaction.user.updateMany({
        where: {
          id: target.id,
          companyId: target.companyId,
          roleId: target.roleId,
          companyStoreId: target.companyStoreId,
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        data: { roleId: role.id, companyStoreId: branchAfter },
      });
      if (changed.count === 0)
        throw new ConflictException('This member was just changed; reload');

      await this.history.record(transaction, [
        {
          companyId: target.companyId,
          userId: target.id,
          reason: MembershipChangeReason.ROLE_CHANGED,
          fromRoleId: target.roleId,
          toRoleId: role.id,
          fromCornerId: target.companyStoreId,
          toCornerId: branchAfter,
          changedByUserId: caller.id,
        },
      ]);
    });

    const event: MemberRoleChangedEvent = {
      memberUserId: target.id,
      changedByUserId: caller.id,
      toRoleCode: dto.role,
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_ROLE_CHANGED, event);

    return this.toView(await this.findRow(target.id));
  }

  /**
   * A member of the caller's company (the admin: of any company) who can be
   * moved or re-roled. Everyone else is "not found": the admin's scope is {},
   * so this also rules out the platform admin and members with no role yet.
   */
  private async findTarget(caller: AuthUser, userId: string) {
    const target = await this.prisma.user.findFirst({
      where: {
        id: userId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: MEMBER_SELECT,
    });
    const roleCode = target?.role?.code;
    if (
      !target ||
      target.companyId === null ||
      roleCode === undefined ||
      !isMemberRole(roleCode)
    )
      throw new NotFoundException('Member not found');
    return { ...target, companyId: target.companyId, roleCode: roleCode };
  }

  private findRow(userId: string): Promise<MemberRow> {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: MEMBER_SELECT,
    });
  }

  private async toView(row: MemberRow): Promise<MemberView> {
    return {
      id: row.id,
      name: row.name,
      profileImageUrl: row.profileImageUrl
        ? await this.storage.presignGetUrl(row.profileImageUrl)
        : null,
      phone: row.phone,
      contactEmail: row.contactEmail,
      status: row.status,
      role: row.role,
      branch: row.companyStore,
      createdAt: row.createdAt,
    };
  }
}
