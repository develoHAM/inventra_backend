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
  MemberApprovedEvent,
  MemberRoleChangedEvent,
} from '../notifications/notification-events';
import { decideRoleChange, isMemberRole } from './member-rules';
import type { RoleChangeDecision } from './member-rules';
import type { MemberRow, ProfileRow, ProfileView } from './profile-view';
import { ApproveProfileDto } from './dto/approve-profile.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { ListProfilesQueryDto } from './dto/list-profiles-query.dto';
import { HistoryQueryDto } from '../membership-history/dto/history-query.dto';
import type { MembershipHistoryPage } from '../membership-history/membership-change-view';

/** One history row's branch, before and after: one per assignment a change touches. */
type BranchChange = { fromCornerId: string | null; toCornerId: string | null };

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
        (caller.roleCode === 'MANAGER' && caller.branchIds.length > 0));

    // Hidden unless asked for: people waiting for approval (from anyone who
    // can't approve them, even when asked), and people who left (unless
    // ?status= names a status), so someone who left and rejoined shows once.
    // ONE NOT with a list: an object can't hold two NOT keys, and a second
    // spread would silently replace the first.
    const hiddenStatuses = [
      ...(canApprove ? [] : [ProfileStatus.PENDING_APPROVAL]),
      ...(query.status ? [] : [ProfileStatus.DEACTIVATED]),
    ];

    const rows = await this.prisma.profile.findMany({
      where: {
        companyId: companyId,
        deletedAt: null,
        ...(hiddenStatuses.length > 0
          ? { NOT: { status: { in: hiddenStatuses } } }
          : {}),
        ...(query.cornerId
          ? { branches: this.branchFilter(query.cornerId) }
          : {}),
        ...(query.role ? { role: { code: query.role } } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      select: {
        id: true,
        name: true,
        profileImageUrl: true,
        account: { select: { phone: true } }, // the sign-in's phone, shared by all their companies
        contactEmail: true,
        status: true,
        createdAt: true,
        companyId: true,
        roleId: true,
        role: { select: { code: true, name: true } },
        // Where they work now, oldest assignment first. Live only: an ended
        // assignment, or one in a deleted branch, stays out of the view.
        branches: {
          where: { deletedAt: null, companyStore: { deletedAt: null } },
          select: { companyStore: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((row) => this.toView(row)));
  }

  /**
   * Approve someone who joined with the company code, choosing their role
   * and their first branch (or none) in one step. The admin and owners
   * approve as any role (an owner never gets a branch); managers only as
   * staff, into a branch they work in.
   */
  async approve(
    caller: AuthProfile,
    profileId: string,
    dto: ApproveProfileDto,
  ): Promise<ProfileView> {
    // A pending member has no role yet, so this is the plain scoped lookup
    // (findMember would treat them as "not found").
    const target = await this.prisma.profile.findFirst({
      where: {
        id: profileId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: { id: true, companyId: true, status: true, roleId: true },
    });
    if (!target || target.companyId === null) {
      throw new NotFoundException('Member not found');
    }
    if (target.status !== ProfileStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Member is not pending approval');
    }
    // Pending with a role already = a company owner waiting for their company
    // to be approved (PATCH /companies/:id/approve). Approving them here as a
    // manager or staff would leave the company with no owner.
    if (target.roleId !== null) {
      throw new BadRequestException(
        'This is a company owner awaiting company approval; approve the company instead',
      );
    }

    const role = await this.prisma.role.findUnique({
      where: {
        id: dto.roleId,
      },
    });
    if (!role || !isMemberRole(role.code)) {
      throw new BadRequestException('Invalid role for a member');
    }
    // The shape before the permission: owners work across the whole
    // company, so an owner with a branch is refused whoever asks.
    if (role.code === 'OWNER' && dto.cornerId !== null) {
      throw new BadRequestException('Owners work across the whole company');
    }

    // A guest list, not a blacklist: the admin and owners approve freely,
    // managers within their limits, and every other role is refused, even
    // one given profiles.approve personally.
    const isAdminOrOwner =
      caller.roleCode === 'ADMIN' || caller.roleCode === 'OWNER';
    if (!isAdminOrOwner) {
      if (caller.roleCode !== 'MANAGER') {
        throw new ForbiddenException(
          'Only owners and managers can approve members',
        );
      }
      if (role.code !== 'STAFF') {
        throw new ForbiddenException('Managers can approve only as staff');
      }
      // cornerId null is no branch at all, so never one of theirs.
      const intoTheirBranch =
        dto.cornerId !== null && caller.branchIds.includes(dto.cornerId);
      if (!intoTheirBranch) {
        throw new ForbiddenException(
          'Managers can approve only into their own branch',
        );
      }
    }

    const companyId = target.companyId;
    const cornerId = dto.cornerId;
    await this.prisma.$transaction(async (transaction) => {
      // Locks in the usual order: the branch, then the member.
      if (cornerId !== null) {
        const isLive = await this.corners.lockLiveCorner(
          transaction,
          cornerId,
          companyId,
        );
        if (!isLive) {
          throw new NotFoundException('Branch not found');
        }
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
        },
      });
      if (approved.count === 0) {
        throw new ConflictException('This member was just changed; reload');
      }

      if (cornerId !== null) {
        // Their first assignment. The partial unique index allows one live
        // row per person per branch: a second is skipped, not thrown, and
        // the empty array that comes back is our 409.
        const started = await transaction.profileBranch.createManyAndReturn({
          data: [{ profileId: target.id, companyStoreId: cornerId }],
          skipDuplicates: true,
          select: { id: true },
        });
        if (started.length === 0) {
          throw new ConflictException('Already in this branch');
        }
      }

      await this.history.record(transaction, [
        {
          companyId: companyId,
          profileId: target.id,
          reason: MembershipChangeReason.APPROVED,
          fromRoleId: null,
          toRoleId: role.id,
          fromCornerId: null,
          toCornerId: cornerId,
          changedByProfileId: caller.id,
        },
      ]);
    });

    const event: MemberApprovedEvent = {
      memberProfileId: target.id,
      approvedByProfileId: caller.id,
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_APPROVED, event);

    return this.viewOf(target.id);
  }

  /**
   * Promote or demote a member, following decideRoleChange. Takes effect at
   * once; the person is notified. Their branches follow the decision: kept
   * (staff ↔ manager), all ended (to owner), or one chosen (an owner demoted).
   */
  async changeRole(
    caller: AuthProfile,
    profileId: string,
    dto: ChangeRoleDto,
  ): Promise<ProfileView> {
    const target = await this.findTarget(caller, profileId);
    if (target.status !== ProfileStatus.ACTIVE) {
      throw new BadRequestException('Only active members can be changed');
    }

    // A null cornerId still counts as sent, so it's refused for anything but
    // demoting an owner. For a demoted owner, not sent and null both mean
    // "no branch".
    const cornerIdSent = dto.cornerId !== undefined;
    const decision = decideRoleChange({
      callerRole: caller.roleCode,
      isSelf: target.id === caller.id,
      targetRole: target.roleCode,
      requestedRole: dto.role,
      cornerIdSent: cornerIdSent,
    });
    if (decision === 'noop') {
      return this.toView(target);
    }

    // Role ids differ between databases; the code is the stable name.
    const role = await this.prisma.role.findUniqueOrThrow({
      where: { code: dto.role },
    });
    const landingCornerId =
      decision.branch === 'set' ? (dto.cornerId ?? null) : null;

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
        if (activeOwners < 2) {
          throw new ConflictException('A company needs at least one owner');
        }
      }

      if (landingCornerId !== null) {
        const isLive = await this.corners.lockLiveCorner(
          transaction,
          landingCornerId,
          target.companyId,
        );
        if (!isLive) {
          throw new NotFoundException('Branch not found');
        }
      }

      // The where repeats what we read: if anyone changed this member in
      // between, nothing matches and count is 0. Writing the row also locks
      // it, and adding or removing a branch writes it first too, so the
      // assignments below can't change under us.
      const changed = await transaction.profile.updateMany({
        where: {
          id: target.id,
          companyId: target.companyId,
          roleId: target.roleId,
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
        data: { roleId: role.id },
      });
      if (changed.count === 0) {
        throw new ConflictException('This member was just changed; reload');
      }

      const branchChanges = await this.applyBranchDecision(
        transaction,
        decision.branch,
        target.id,
        caller.id,
        landingCornerId,
      );

      await this.history.record(
        transaction,
        branchChanges.map((branchChange) => ({
          companyId: target.companyId,
          profileId: target.id,
          reason: MembershipChangeReason.ROLE_CHANGED,
          fromRoleId: target.roleId,
          toRoleId: role.id,
          fromCornerId: branchChange.fromCornerId,
          toCornerId: branchChange.toCornerId,
          changedByProfileId: caller.id,
        })),
      );
    });

    const event: MemberRoleChangedEvent = {
      memberProfileId: target.id,
      changedByProfileId: caller.id,
      toRoleCode: dto.role,
    };
    this.eventEmitter.emit(NotificationEvent.MEMBER_ROLE_CHANGED, event);

    return this.viewOf(target.id);
  }

  /**
   * One person's history, newest first. Readable by the person themselves,
   * the admin, an owner, or a manager who works in a branch the person
   * works in now.
   */
  async listHistory(
    caller: AuthProfile,
    profileId: string,
    query: HistoryQueryDto,
  ): Promise<MembershipHistoryPage> {
    // A plain scoped lookup, not findMember: someone still waiting for
    // approval has no role yet, but their (empty) history is theirs to read.
    const person = await this.prisma.profile.findFirst({
      where: {
        id: profileId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: {
        id: true,
        branches: {
          where: { deletedAt: null, companyStore: { deletedAt: null } },
          select: { companyStoreId: true },
        },
      },
    });
    if (!person) {
      throw new NotFoundException('Member not found');
    }

    const isSelf = person.id === caller.id;
    const isAdminOrOwner =
      caller.roleCode === 'ADMIN' || caller.roleCode === 'OWNER';
    // One branch in common is enough. A manager with no branch shares none,
    // so they read nobody's, not everyone else with no branch.
    const sharesABranch =
      caller.roleCode === 'MANAGER' &&
      person.branches.some((assignment) =>
        caller.branchIds.includes(assignment.companyStoreId),
      );
    if (!isSelf && !isAdminOrOwner && !sharesABranch) {
      throw new ForbiddenException("You cannot read this member's history");
    }

    return this.history.page({ profileId: person.id }, query);
  }

  /**
   * A member of the caller's company (the admin: of any company) with a
   * member role, or null; the caller decides the 404. The admin's scope is
   * {}, so this also rules out the platform admin and members with no role yet.
   */
  async findMember(
    caller: AuthProfile,
    profileId: string,
  ): Promise<MemberRow | null> {
    const row = await this.prisma.profile.findFirst({
      where: {
        id: profileId,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        profileImageUrl: true,
        account: { select: { phone: true } }, // the sign-in's phone, shared by all their companies
        contactEmail: true,
        status: true,
        createdAt: true,
        companyId: true,
        roleId: true,
        role: { select: { code: true, name: true } },
        // Where they work now, oldest assignment first. Live only: an ended
        // assignment, or one in a deleted branch, stays out of the view.
        branches: {
          where: { deletedAt: null, companyStore: { deletedAt: null } },
          select: { companyStore: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const roleCode = row?.role?.code;
    if (
      !row ||
      row.companyId === null ||
      roleCode === undefined ||
      !isMemberRole(roleCode)
    ) {
      return null;
    }
    return { ...row, companyId: row.companyId, roleCode: roleCode };
  }

  /** The member as the API returns them, read fresh (after a change). */
  async viewOf(profileId: string): Promise<ProfileView> {
    return this.toView(await this.findRow(profileId));
  }

  private async findTarget(
    caller: AuthProfile,
    profileId: string,
  ): Promise<MemberRow> {
    const target = await this.findMember(caller, profileId);
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    return target;
  }

  /**
   * ?cornerId= as a relation filter: "works in X" or, for "none", "works
   * in no branch". Both say live, since ended assignments stay as history:
   * someone whose only Gangnam row has ended has no branch.
   */
  private branchFilter(
    cornerId: string,
  ): Prisma.ProfileBranchListRelationFilter {
    if (cornerId === 'none') {
      return { none: { deletedAt: null, companyStore: { deletedAt: null } } };
    }
    return {
      some: {
        companyStoreId: cornerId,
        deletedAt: null,
        companyStore: { deletedAt: null },
      },
    };
  }

  /**
   * Inside changeRole's transaction, after the member's row is locked: what
   * the new role does to their branches, as one (from, to) pair per
   * assignment it touches. Someone with no branch still gets one pair,
   * (none, none), so every role change has a history row.
   */
  private async applyBranchDecision(
    transaction: Prisma.TransactionClient,
    branch: Exclude<RoleChangeDecision, 'noop'>['branch'],
    profileId: string,
    callerId: string,
    landingCornerId: string | null,
  ): Promise<BranchChange[]> {
    let branchChanges: BranchChange[];
    if (branch === 'clear') {
      // Promoted to owner: owners work everywhere, so every assignment ends.
      // One statement ends them AND reports which, one history row each.
      const ended = await transaction.profileBranch.updateManyAndReturn({
        where: { profileId: profileId, deletedAt: null },
        data: { deletedAt: new Date(), deletedByProfileId: callerId },
        select: { companyStoreId: true },
      });
      branchChanges = ended.map((assignment) => ({
        fromCornerId: assignment.companyStoreId,
        toCornerId: null,
      }));
    } else if (branch === 'keep') {
      // Staff ↔ manager: the same branches, a new role in each.
      const live = await transaction.profileBranch.findMany({
        where: {
          profileId: profileId,
          deletedAt: null,
          companyStore: { deletedAt: null },
        },
        select: { companyStoreId: true },
        orderBy: { createdAt: 'asc' },
      });
      branchChanges = live.map((assignment) => ({
        fromCornerId: assignment.companyStoreId,
        toCornerId: assignment.companyStoreId,
      }));
    } else {
      // An owner demoted: they had no assignments, and land in the branch
      // they were given, or none.
      if (landingCornerId !== null) {
        // One live row per person per branch: a duplicate is skipped and
        // the empty array is our 409.
        const started = await transaction.profileBranch.createManyAndReturn({
          data: [{ profileId: profileId, companyStoreId: landingCornerId }],
          skipDuplicates: true,
          select: { id: true },
        });
        if (started.length === 0) {
          throw new ConflictException('Already in this branch');
        }
      }
      branchChanges = [{ fromCornerId: null, toCornerId: landingCornerId }];
    }
    if (branchChanges.length === 0) {
      return [{ fromCornerId: null, toCornerId: null }];
    }
    return branchChanges;
  }

  private findRow(profileId: string): Promise<ProfileRow> {
    return this.prisma.profile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        id: true,
        name: true,
        profileImageUrl: true,
        account: { select: { phone: true } }, // the sign-in's phone, shared by all their companies
        contactEmail: true,
        status: true,
        createdAt: true,
        companyId: true,
        roleId: true,
        role: { select: { code: true, name: true } },
        // Where they work now, oldest assignment first. Live only: an ended
        // assignment, or one in a deleted branch, stays out of the view.
        branches: {
          where: { deletedAt: null, companyStore: { deletedAt: null } },
          select: { companyStore: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
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
      branches: row.branches.map((assignment) => assignment.companyStore),
      createdAt: row.createdAt,
    };
  }
}
