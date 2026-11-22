import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  MembershipChangeReason,
  ProfileStatus,
} from '../generated/prisma/enums';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import type { MembershipChangeInput } from '../membership-history/membership-change';
import type { AuthProfile } from '../auth/types/auth-profile';
import { NotificationEvent } from '../notifications/notification-events';
import type {
  MemberLeftEvent,
  MemberRoleChangedEvent,
} from '../notifications/notification-events';
import type { NotificationEventName } from '../notifications/event-channels';
import { pickSuccessor } from './member-rules';
import { LeaveCompanyDto } from './dto/leave-company.dto';

/** What leaving would need: GET /profiles/me/leave-preview. */
export interface LeavePreview {
  // the leaver is the last ACTIVE owner and nobody could take over
  companyWillClose: boolean;
  owner: {
    successorNeeded: boolean; // false while another ACTIVE owner remains
    candidates: { profileId: string; name: string; role: string }[];
    defaultPick: string | null; // who the system would pick, if none is named
  } | null; // null when the leaver isn't an ACTIVE owner
}

/** The new owner, and how they were chosen. */
export interface Successor {
  profileId: string;
  name: string;
  picked: 'CHOSEN' | 'AUTO'; // named by the leaver, or picked by the system
}

/** What POST /profiles/me/leave answers. */
export interface LeaveSummary {
  companyClosed: boolean;
  newOwner: Successor | null;
}

/** What the shared procedure hands back: the summary, and what to announce after the commit. */
export interface LeaveOutcome {
  summary: LeaveSummary;
  events: { name: NotificationEventName; payload: object }[];
}

/**
 * Leaving a company. The procedure (leaveInTransaction) is shared by
 * leaving, removal and account deletion: each opens its own transaction,
 * runs it, and sends its events after the commit.
 */
@Injectable()
export class LeavingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: MembershipHistoryService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** What leaving would need, without changing anything: a forecast, not a promise. */
  async preview(caller: AuthProfile): Promise<LeavePreview> {
    if (caller.companyId === null) {
      throw new ForbiddenException(
        'The platform admin has no company to leave',
      );
    }
    // An owner still waiting for approval: leaving withdraws their company.
    if (
      caller.roleCode === 'OWNER' &&
      caller.status === ProfileStatus.PENDING_APPROVAL
    ) {
      return { companyWillClose: true, owner: null };
    }
    if (caller.roleCode !== 'OWNER') {
      return { companyWillClose: false, owner: null };
    }

    const otherActiveOwners = await this.prisma.profile.count({
      where: {
        companyId: caller.companyId,
        id: { not: caller.id },
        role: { code: 'OWNER' },
        status: ProfileStatus.ACTIVE,
        deletedAt: null,
      },
    });
    if (otherActiveOwners > 0) {
      return {
        companyWillClose: false,
        owner: { successorNeeded: false, candidates: [], defaultPick: null },
      };
    }

    // Who could take over: the ACTIVE managers and staff, other than the leaver.
    const rows = await this.prisma.profile.findMany({
      where: {
        companyId: caller.companyId,
        status: ProfileStatus.ACTIVE,
        deletedAt: null,
        id: { not: caller.id },
        role: { code: { in: ['MANAGER', 'STAFF'] } },
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
        role: { select: { code: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    // the where guarantees a role; flatMap drops the impossible null for TypeScript
    const candidates = rows.flatMap((row) =>
      row.role
        ? [
            {
              profileId: row.id,
              name: row.name,
              createdAt: row.createdAt,
              roleCode: row.role.code,
            },
          ]
        : [],
    );
    return {
      companyWillClose: candidates.length === 0,
      owner: {
        successorNeeded: true,
        candidates: candidates.map((candidate) => ({
          profileId: candidate.profileId,
          name: candidate.name,
          role: candidate.roleCode,
        })),
        defaultPick: pickSuccessor(candidates),
      },
    };
  }

  /** POST /profiles/me/leave: the open profile leaves its company. */
  async leave(
    caller: AuthProfile,
    dto: LeaveCompanyDto,
  ): Promise<LeaveSummary> {
    if (caller.companyId === null) {
      throw new ForbiddenException(
        'The platform admin has no company to leave',
      );
    }
    const companyId = caller.companyId;

    const outcome = await this.prisma.$transaction((transaction) =>
      this.leaveInTransaction(transaction, {
        profileId: caller.id,
        companyId: companyId,
        actorProfileId: caller.id, // who did it: here, themselves
        reason: 'LEFT_COMPANY',
        // null and left out mean the same: nobody named
        ownerSuccessorProfileId: dto.ownerSuccessorProfileId ?? undefined,
      }),
    );
    // Only now, after the commit: never announce a leave that rolled back.
    for (const event of outcome.events) {
      this.eventEmitter.emit(event.name, event.payload);
    }
    return outcome.summary;
  }

  /**
   * The leave procedure, inside the caller's transaction (leaving, removal
   * and account deletion each open their own). Returns the events instead
   * of sending them: only the caller knows when its transaction commits.
   * The steps follow the spec: lock, re-read, owner part, the leaver, history.
   */
  async leaveInTransaction(
    transaction: Prisma.TransactionClient,
    input: {
      profileId: string;
      companyId: string;
      actorProfileId: string; // the leaver, or the remover
      reason: 'LEFT_COMPANY' | 'REMOVED' | 'ACCOUNT_DELETED';
      ownerSuccessorProfileId?: string;
    },
  ): Promise<LeaveOutcome> {
    const now = new Date();

    // 1. The company lock, before anything else. Every way out of this
    // company writes this row first, so two of them run one after the other,
    // and the owner count below always sees what the other one left.
    await transaction.company.updateMany({
      where: { id: input.companyId },
      data: { updatedAt: now },
    });

    // 2. Re-read the leaver under the lock: what was read before may be stale.
    const leaver = await transaction.profile.findFirst({
      where: {
        id: input.profileId,
        companyId: input.companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        roleId: true,
        status: true,
        role: { select: { code: true } },
      },
    });
    // Who may go out this way: leaving from ACTIVE or PENDING_APPROVAL (a
    // waiting request is withdrawn), removal from ACTIVE or SUSPENDED, account
    // deletion from anything but DEACTIVATED.
    const allowedStatuses: ProfileStatus[] =
      input.reason === 'LEFT_COMPANY'
        ? [ProfileStatus.ACTIVE, ProfileStatus.PENDING_APPROVAL]
        : input.reason === 'REMOVED'
          ? [ProfileStatus.ACTIVE, ProfileStatus.SUSPENDED]
          : [
              ProfileStatus.PENDING_APPROVAL,
              ProfileStatus.ACTIVE,
              ProfileStatus.SUSPENDED,
              ProfileStatus.REJECTED,
            ];
    if (!leaver || !allowedStatuses.includes(leaver.status)) {
      throw new ConflictException('This member was just changed; reload');
    }

    const isPending = leaver.status === ProfileStatus.PENDING_APPROVAL;
    const isOwner = leaver.role?.code === 'OWNER';
    const isActiveOwner = isOwner && leaver.status === ProfileStatus.ACTIVE;
    if (!isActiveOwner && input.ownerSuccessorProfileId !== undefined) {
      throw new BadRequestException('No owner successor is needed');
    }

    // 3. The owner part: who leads the company once the last ACTIVE owner
    // is gone? A named successor, else the system's pick, else nobody: the
    // company closes. A pending owner's company is still waiting for
    // approval, so their leaving withdraws it.
    let successor: {
      profileId: string;
      name: string;
      roleId: number | null;
    } | null = null;
    let picked: Successor['picked'] = 'AUTO';
    let closing = isPending && isOwner;
    if (isActiveOwner) {
      const otherActiveOwners = await transaction.profile.count({
        where: {
          companyId: input.companyId,
          id: { not: leaver.id },
          role: { code: 'OWNER' },
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
      });
      if (otherActiveOwners > 0) {
        if (input.ownerSuccessorProfileId !== undefined) {
          throw new BadRequestException('No owner successor is needed');
        }
      } else {
        const rows = await transaction.profile.findMany({
          where: {
            companyId: input.companyId,
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
            id: { not: leaver.id },
            role: { code: { in: ['MANAGER', 'STAFF'] } },
          },
          select: {
            id: true,
            name: true,
            createdAt: true,
            roleId: true,
            role: { select: { code: true } },
          },
        });
        // the where guarantees a role; flatMap drops the impossible null for TypeScript
        const candidates = rows.flatMap((row) =>
          row.role
            ? [
                {
                  profileId: row.id,
                  name: row.name,
                  createdAt: row.createdAt,
                  roleId: row.roleId,
                  roleCode: row.role.code,
                },
              ]
            : [],
        );
        if (input.ownerSuccessorProfileId !== undefined) {
          // Only a candidate may take over: never someone pending, an owner,
          // someone of another company, or the leaver themselves.
          successor =
            candidates.find(
              (candidate) =>
                candidate.profileId === input.ownerSuccessorProfileId,
            ) ?? null;
          if (!successor) {
            throw new BadRequestException(
              'This person cannot take over as owner',
            );
          }
          picked = 'CHOSEN';
        } else {
          const pickedProfileId = pickSuccessor(candidates);
          successor =
            candidates.find(
              (candidate) => candidate.profileId === pickedProfileId,
            ) ?? null;
          closing = successor === null; // nobody left to lead
        }
      }
    }

    const historyRows: MembershipChangeInput[] = [];
    const events: LeaveOutcome['events'] = [];
    let newOwner: Successor | null = null;

    if (successor) {
      // The leaver names who took over; a system pick names nobody (null).
      const changedBy = picked === 'CHOSEN' ? input.actorProfileId : null;
      const ownerRole = await transaction.role.findUniqueOrThrow({
        where: { code: 'OWNER' },
      });
      // Guarded: still ACTIVE, still the role we read. Promoted, left or
      // removed a moment ago → nothing matches, count 0.
      const promoted = await transaction.profile.updateMany({
        where: {
          id: successor.profileId,
          companyId: input.companyId,
          roleId: successor.roleId,
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
        data: { roleId: ownerRole.id },
      });
      if (promoted.count === 0) {
        throw new ConflictException('This member was just changed; reload');
      }
      // Owners work in every branch: their assignments end, and the receipt
      // says which, one history row each.
      const endedForSuccessor =
        await transaction.profileBranch.updateManyAndReturn({
          where: { profileId: successor.profileId, deletedAt: null },
          data: { deletedAt: now, deletedByProfileId: changedBy },
          select: { companyStoreId: true },
        });
      const successorCornerIds: (string | null)[] =
        endedForSuccessor.length > 0
          ? endedForSuccessor.map((assignment) => assignment.companyStoreId)
          : [null]; // no branch: still one row, (role, none) → (OWNER, none)
      for (const cornerId of successorCornerIds) {
        historyRows.push({
          companyId: input.companyId,
          profileId: successor.profileId,
          reason:
            picked === 'CHOSEN'
              ? MembershipChangeReason.ROLE_CHANGED
              : MembershipChangeReason.AUTO_PROMOTED,
          fromRoleId: successor.roleId,
          toRoleId: ownerRole.id,
          fromCornerId: cornerId,
          toCornerId: null,
          changedByProfileId: changedBy,
        });
      }
      newOwner = {
        profileId: successor.profileId,
        name: successor.name,
        picked: picked,
      };
      const roleChanged: MemberRoleChangedEvent = {
        memberProfileId: successor.profileId,
        changedByProfileId: changedBy,
        toRoleCode: 'OWNER',
      };
      events.push({
        name: NotificationEvent.MEMBER_ROLE_CHANGED,
        payload: roleChanged,
      });
    }

    // Closing: the company and its branches first (the lock order is
    // company → branches → profiles → assignments).
    let closedCornerIds: string[] = [];
    if (closing) {
      await transaction.company.updateMany({
        where: { id: input.companyId, deletedAt: null },
        data: { deletedAt: now, deletedByProfileId: leaver.id },
      });
      const closedBranches = await transaction.companyStore.updateManyAndReturn(
        {
          where: { companyId: input.companyId, deletedAt: null },
          data: { deletedAt: now, deletedByProfileId: leaver.id },
          select: { id: true },
        },
      );
      closedCornerIds = closedBranches.map((branch) => branch.id);
    }

    // 4. The leaver: DEACTIVATED through a guarded write (removed or left a
    // moment ago → count 0). The role stays, for the record: owner counts
    // already ask for ACTIVE.
    const deactivated = await transaction.profile.updateMany({
      where: {
        id: leaver.id,
        status: { in: allowedStatuses },
        deletedAt: null,
      },
      data: { status: ProfileStatus.DEACTIVATED },
    });
    if (deactivated.count === 0) {
      throw new ConflictException('This member was just changed; reload');
    }

    if (closing) {
      // Everyone else still on the books (pending, suspended, rejected) goes
      // too, then every assignment in the closed branches ends.
      const othersClosed = await transaction.profile.updateManyAndReturn({
        where: {
          companyId: input.companyId,
          id: { not: leaver.id },
          deletedAt: null,
          status: { not: ProfileStatus.DEACTIVATED },
        },
        data: { status: ProfileStatus.DEACTIVATED },
        select: { id: true, roleId: true },
      });
      const endedInCompany =
        await transaction.profileBranch.updateManyAndReturn({
          where: { companyStoreId: { in: closedCornerIds }, deletedAt: null },
          data: { deletedAt: now, deletedByProfileId: leaver.id },
          select: { profileId: true, companyStoreId: true },
        });
      // 5. COMPANY_CLOSED rows for the leaver (unless pending: their history
      // hasn't started) and everyone else who had a role, one per ended
      // assignment.
      const closedPeople = [
        ...(isPending ? [] : [{ id: leaver.id, roleId: leaver.roleId }]),
        ...othersClosed.filter((person) => person.roleId !== null),
      ];
      for (const person of closedPeople) {
        const personCornerIds = endedInCompany
          .filter((assignment) => assignment.profileId === person.id)
          .map((assignment) => assignment.companyStoreId);
        const cornerIds: (string | null)[] =
          personCornerIds.length > 0 ? personCornerIds : [null];
        for (const cornerId of cornerIds) {
          historyRows.push({
            companyId: input.companyId,
            profileId: person.id,
            reason: MembershipChangeReason.COMPANY_CLOSED,
            fromRoleId: person.roleId,
            toRoleId: null,
            fromCornerId: cornerId,
            toCornerId: null,
            changedByProfileId: input.actorProfileId,
          });
        }
      }
      // nobody is left to tell
    } else if (!isPending) {
      // A pending leaver had no assignments and no history: only DEACTIVATED.
      const endedForLeaver =
        await transaction.profileBranch.updateManyAndReturn({
          where: { profileId: leaver.id, deletedAt: null },
          data: { deletedAt: now, deletedByProfileId: input.actorProfileId },
          select: { companyStoreId: true },
        });
      const leaverCornerIds = endedForLeaver.map(
        (assignment) => assignment.companyStoreId,
      );
      // 5. One row per ended assignment, (role, branch) → (none, none).
      const cornerIds: (string | null)[] =
        leaverCornerIds.length > 0 ? leaverCornerIds : [null];
      for (const cornerId of cornerIds) {
        historyRows.push({
          companyId: input.companyId,
          profileId: leaver.id,
          reason: MembershipChangeReason[input.reason],
          fromRoleId: leaver.roleId,
          toRoleId: null,
          fromCornerId: cornerId,
          toCornerId: null,
          changedByProfileId: input.actorProfileId,
        });
      }
      const left: MemberLeftEvent = {
        companyId: input.companyId,
        memberProfileId: leaver.id,
        memberName: leaver.name,
        cornerIds: leaverCornerIds,
        reason: input.reason,
        changedByProfileId: input.actorProfileId,
      };
      events.push({ name: NotificationEvent.MEMBER_LEFT, payload: left });
    }

    await this.history.record(transaction, historyRows);
    return {
      summary: { companyClosed: closing, newOwner: newOwner },
      events: events,
    };
  }
}
