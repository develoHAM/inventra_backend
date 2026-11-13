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
import { PermissionsService } from '../authorization/permissions.service';
import { CornersService } from '../corners/corners.service';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import { StorageService } from '../storage/storage.service';
import type { AuthProfile } from '../auth/types/auth-profile';
import {
  MembershipChangeReason,
  ProfileStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';
import type {
  MemberMovedEvent,
  MemberApprovedEvent,
  MemberRoleChangedEvent,
} from '../notifications/notification-events';
import { decideRoleChange, isMemberRole } from './member-rules';
import { PROFILE_SELECT } from './profile-view';
import type { ProfileRow, ProfileView } from './profile-view';
import { ChangeBranchDto } from './dto/change-branch.dto';
import { ApproveProfileDto } from './dto/approve-profile.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { ListProfilesQueryDto } from './dto/list-profiles-query.dto';
import { HistoryQueryDto } from '../membership-history/dto/history-query.dto';
import type { MembershipHistoryPage } from '../membership-history/membership-change-view';

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly permissions: PermissionsService,
    private readonly corners: CornersService,
    private readonly history: MembershipHistoryService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * The members of one company, oldest first: the caller's own, or the one
   * the admin names. People still waiting for approval aren't colleagues yet,
   * so only those who can approve them see them.
   */
  async list(
    caller: AuthProfile,
    query: ListProfilesQueryDto,
  ): Promise<ProfileView[]> {
    const companyId = this.ownership.resolveTargetCompany(
      caller,
      query.companyId,
    );
    const callerPermissions =
      await this.permissions.getEffectivePermissions(caller);
    // Who can really approve: holds profiles.approve (role + personal overrides)
    // AND passes approve()'s role rules. A personal GRANT gets staff past the
    // guard but not past approve(), and a manager with no branch can approve
    // no one, so neither is shown who is waiting.
    const canApprove =
      callerPermissions.has('profiles.approve') &&
      (caller.roleCode === 'ADMIN' ||
        caller.roleCode === 'OWNER' ||
        (caller.roleCode === 'MANAGER' &&
          (caller.companyStoreId ?? null) !== null));

    const rows = await this.prisma.profile.findMany({
      where: {
        companyId: companyId,
        deletedAt: null,
        ...(canApprove
          ? {}
          : { NOT: { status: ProfileStatus.PENDING_APPROVAL } }),
        ...(query.cornerId
          ? {
              companyStoreId: query.cornerId === 'none' ? null : query.cornerId,
            }
          : {}),
        ...(query.role ? { role: { code: query.role } } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      select: PROFILE_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((row) => this.toView(row)));
  }

  /**
   * Approve someone who joined with the company code, choosing their role
   * and branch in one step. Managers approve only as staff, into their own
   * branch.
   */
  async approve(
    caller: AuthProfile,
    profileId: string,
    dto: ApproveProfileDto,
  ): Promise<ProfileView> {
    // A pending member has no role yet, so this is the plain scoped lookup
    // (findTarget would treat them as "not found").
    const target = await this.prisma.profile.findFirst({
      where: {
        id: profileId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: PROFILE_SELECT,
    });
    if (!target || target.companyId === null)
      throw new NotFoundException('Member not found');
    if (target.status !== ProfileStatus.PENDING_APPROVAL)
      throw new BadRequestException('Member is not pending approval');
    // Pending with a role already = a company owner waiting for their company
    // to be approved (PATCH /companies/:id/approve). Approving them here as a
    // manager or staff would leave the company with no owner.
    if (target.roleId !== null)
      throw new BadRequestException(
        'This is a company owner awaiting company approval; approve the company instead',
      );

    const role = await this.prisma.role.findUnique({
      where: {
        id: dto.roleId,
      },
    });
    if (!role || (role.code !== 'MANAGER' && role.code !== 'STAFF'))
      throw new BadRequestException('Invalid role for a member');

    // A guest list, not a blacklist: the admin and owners approve freely,
    // managers within their limits, and every other role is refused, even
    // one given profiles.approve personally.
    const isAdminOrOwner =
      caller.roleCode === 'ADMIN' || caller.roleCode === 'OWNER';
    if (!isAdminOrOwner) {
      if (caller.roleCode !== 'MANAGER')
        throw new ForbiddenException(
          'Only owners and managers can approve members',
        );
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

      // Still a pending newcomer? If someone approved them a moment ago,
      // nothing matches and count is 0.
      const approved = await transaction.profile.updateMany({
        where: {
          id: target.id,
          status: ProfileStatus.PENDING_APPROVAL,
          roleId: null,
          deletedAt: null,
        },
        data: {
          roleId: role.id,
          status: ProfileStatus.ACTIVE,
          companyStoreId: dto.cornerId,
        },
      });
      if (approved.count === 0)
        throw new ConflictException('This member was just changed; reload');

      await this.history.record(transaction, [
        {
          companyId: companyId,
          profileId: target.id,
          reason: MembershipChangeReason.APPROVED,
          fromRoleId: target.roleId,
          toRoleId: role.id,
          fromCornerId: target.companyStoreId,
          toCornerId: dto.cornerId,
          changedByProfileId: caller.id,
        },
      ]);
    });

    const event: MemberApprovedEvent = {
      memberProfileId: target.id,
      approvedByProfileId: caller.id,
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_APPROVED, event);

    return this.toView(await this.findRow(target.id));
  }

  /** Move a manager or staff member to another branch, or off theirs (null). */
  async changeBranch(
    caller: AuthProfile,
    profileId: string,
    dto: ChangeBranchDto,
  ): Promise<ProfileView> {
    if (caller.roleCode !== 'ADMIN' && caller.roleCode !== 'OWNER')
      throw new ForbiddenException(
        'Only an owner can move members between branches',
      );

    const target = await this.findTarget(caller, profileId);
    if (target.status !== ProfileStatus.ACTIVE)
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
      const moved = await transaction.profile.updateMany({
        where: {
          id: target.id,
          companyId: target.companyId,
          roleId: target.roleId,
          companyStoreId: target.companyStoreId,
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
        data: { companyStoreId: dto.cornerId },
      });
      if (moved.count === 0)
        throw new ConflictException('This member was just changed; reload');

      await this.history.record(transaction, [
        {
          companyId: target.companyId,
          profileId: target.id,
          reason: MembershipChangeReason.MOVED,
          fromRoleId: target.roleId,
          toRoleId: target.roleId,
          fromCornerId: target.companyStoreId,
          toCornerId: dto.cornerId,
          changedByProfileId: caller.id,
        },
      ]);
    });

    const event: MemberMovedEvent = {
      memberProfileId: target.id,
      changedByProfileId: caller.id,
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
    caller: AuthProfile,
    profileId: string,
    dto: ChangeRoleDto,
  ): Promise<ProfileView> {
    const target = await this.findTarget(caller, profileId);
    if (target.status !== ProfileStatus.ACTIVE)
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
        const activeOwners = await transaction.profile.count({
          where: {
            companyId: target.companyId,
            role: { code: 'OWNER' },
            status: ProfileStatus.ACTIVE,
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

      const changed = await transaction.profile.updateMany({
        where: {
          id: target.id,
          companyId: target.companyId,
          roleId: target.roleId,
          companyStoreId: target.companyStoreId,
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
        data: { roleId: role.id, companyStoreId: branchAfter },
      });
      if (changed.count === 0)
        throw new ConflictException('This member was just changed; reload');

      await this.history.record(transaction, [
        {
          companyId: target.companyId,
          profileId: target.id,
          reason: MembershipChangeReason.ROLE_CHANGED,
          fromRoleId: target.roleId,
          toRoleId: role.id,
          fromCornerId: target.companyStoreId,
          toCornerId: branchAfter,
          changedByProfileId: caller.id,
        },
      ]);
    });

    const event: MemberRoleChangedEvent = {
      memberProfileId: target.id,
      changedByProfileId: caller.id,
      toRoleCode: dto.role,
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_ROLE_CHANGED, event);

    return this.toView(await this.findRow(target.id));
  }

  /**
   * One person's history, newest first. Readable by the person themselves,
   * the admin, an owner, or a manager whose branch the person is in now.
   */
  async listHistory(
    caller: AuthProfile,
    profileId: string,
    query: HistoryQueryDto,
  ): Promise<MembershipHistoryPage> {
    // A plain scoped lookup, not findTarget: someone still waiting for
    // approval has no role yet, but their (empty) history is theirs to read.
    const person = await this.prisma.profile.findFirst({
      where: {
        id: profileId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: { id: true, companyStoreId: true },
    });
    if (!person) throw new NotFoundException('Member not found');

    const isSelf = person.id === caller.id;
    const isAdminOrOwner =
      caller.roleCode === 'ADMIN' || caller.roleCode === 'OWNER';
    // The manager's branch must be set: a manager with no branch manages
    // nobody, not everyone else with no branch (null === null is true).
    const callerBranchId = caller.companyStoreId ?? null;
    const managesPersonsBranch =
      caller.roleCode === 'MANAGER' &&
      callerBranchId !== null &&
      callerBranchId === person.companyStoreId;
    if (!isSelf && !isAdminOrOwner && !managesPersonsBranch)
      throw new ForbiddenException("You cannot read this member's history");

    return this.history.page({ profileId: person.id }, query);
  }

  /**
   * A member of the caller's company (the admin: of any company) who can be
   * moved or re-roled. Everyone else is "not found": the admin's scope is {},
   * so this also rules out the platform admin and members with no role yet.
   */
  private async findTarget(caller: AuthProfile, profileId: string) {
    const target = await this.prisma.profile.findFirst({
      where: {
        id: profileId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: PROFILE_SELECT,
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

  private findRow(profileId: string): Promise<ProfileRow> {
    return this.prisma.profile.findUniqueOrThrow({
      where: { id: profileId },
      select: PROFILE_SELECT,
    });
  }

  private async toView(row: ProfileRow): Promise<ProfileView> {
    return {
      id: row.id,
      name: row.name,
      profileImageUrl: row.profileImageUrl
        ? await this.storage.presignGetUrl(row.profileImageUrl)
        : null,
      phone: row.account.phone,
      contactEmail: row.contactEmail,
      status: row.status,
      role: row.role,
      branch: row.companyStore,
      createdAt: row.createdAt,
    };
  }
}
