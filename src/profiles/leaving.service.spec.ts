import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LeavingService } from './leaving.service';
import type { LeaveOutcome } from './leaving.service';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import type { Prisma } from '../generated/prisma/client';
import type { AuthProfile } from '../auth/types/auth-profile';
import {
  MembershipChangeReason,
  ProfileStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

/** "Some Date": the moment a row was stamped isn't what these tests check. */
const ANY_DATE: unknown = expect.any(Date);

/**
 * UPL Co: owners Jisoo (and sometimes a co-owner), manager Lee, staff Kim
 * and Park. Park works in Branches A and B.
 */
describe('LeavingService', () => {
  let service: LeavingService;
  let tx: {
    company: { updateMany: jest.Mock };
    companyStore: { updateManyAndReturn: jest.Mock };
    profile: {
      findFirst: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      updateManyAndReturn: jest.Mock;
    };
    profileBranch: { updateManyAndReturn: jest.Mock };
    role: { findUniqueOrThrow: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    profile: { count: jest.Mock; findMany: jest.Mock };
  };
  let history: { record: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  /** The order things happened in: locks, reads, writes, the commit, events. */
  let timeline: string[];
  /** The live assignments each person's assignments-ending statement ends. */
  let assignmentsOf: Record<string, { companyStoreId: string }[]>;
  /** What ending the closed branches' assignments returns. */
  let closedBranchAssignments: { profileId: string; companyStoreId: string }[];
  /** What the re-read of the leaver returns, and what the candidates query returns. */
  let leaverRow: unknown;
  let candidateRows: unknown[];

  // The leaver as the re-read under the lock returns them.
  const park = {
    id: 'park',
    name: 'Park',
    roleId: 4,
    status: ProfileStatus.ACTIVE,
    role: { code: 'STAFF' },
  };
  const jisoo = {
    id: 'jisoo',
    name: 'Jisoo',
    roleId: 2,
    status: ProfileStatus.ACTIVE,
    role: { code: 'OWNER' },
  };
  // The owner candidates as their query returns them.
  const lee = {
    id: 'lee',
    name: 'Lee',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    roleId: 3,
    role: { code: 'MANAGER' },
  };
  const kim = {
    id: 'kim',
    name: 'Kim',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    roleId: 4,
    role: { code: 'STAFF' },
  };

  const ownerCaller: AuthProfile = {
    id: 'jisoo',
    accountId: 'account-of-jisoo',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    branchIds: [],
    status: ProfileStatus.ACTIVE,
  };
  const staffCaller: AuthProfile = {
    id: 'park',
    accountId: 'account-of-park',
    companyId: 'company-1',
    roleId: 4,
    roleCode: 'STAFF',
    branchIds: ['corner-a', 'corner-b'],
    status: ProfileStatus.ACTIVE,
  };
  const adminCaller: AuthProfile = {
    id: 'admin-1',
    accountId: 'account-of-admin-1',
    companyId: null,
    roleId: 1,
    roleCode: 'ADMIN',
    branchIds: [],
    status: ProfileStatus.ACTIVE,
  };

  beforeEach(() => {
    timeline = [];
    assignmentsOf = {
      park: [{ companyStoreId: 'corner-a' }, { companyStoreId: 'corner-b' }],
    };
    closedBranchAssignments = [];
    leaverRow = park;
    candidateRows = [];
    tx = {
      company: {
        updateMany: jest.fn((args: { data: { deletedAt?: Date } }) => {
          timeline.push(args.data.deletedAt ? 'close company' : 'lock company');
          return Promise.resolve({ count: 1 });
        }),
      },
      companyStore: {
        updateManyAndReturn: jest.fn(() => {
          timeline.push('close branches');
          return Promise.resolve([]);
        }),
      },
      profile: {
        findFirst: jest.fn(() => {
          timeline.push('read leaver');
          return Promise.resolve(leaverRow);
        }),
        count: jest.fn(() => {
          timeline.push('count owners');
          return Promise.resolve(0);
        }),
        findMany: jest.fn(() => {
          timeline.push('read candidates');
          return Promise.resolve(candidateRows);
        }),
        updateMany: jest.fn((args: { where: { id: string } }) => {
          timeline.push(`write ${args.where.id}`);
          return Promise.resolve({ count: 1 });
        }),
        updateManyAndReturn: jest.fn(() => {
          timeline.push('deactivate the rest');
          return Promise.resolve([]);
        }),
      },
      profileBranch: {
        updateManyAndReturn: jest.fn(
          (args: { where: { profileId?: string } }) => {
            const profileId = args.where.profileId;
            if (profileId === undefined) {
              timeline.push('end assignments of closed branches');
              return Promise.resolve(closedBranchAssignments);
            }
            timeline.push(`end assignments of ${profileId}`);
            return Promise.resolve(assignmentsOf[profileId] ?? []);
          },
        ),
      },
      role: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 2, code: 'OWNER' }),
      },
    };
    prisma = {
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) => {
        const result = await callback(tx);
        timeline.push('commit');
        return result;
      }),
      profile: { count: jest.fn(), findMany: jest.fn() },
    };
    history = { record: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = {
      emit: jest.fn(() => {
        timeline.push('emit');
        return true;
      }),
    };
    // constructor order: (prisma, history, eventEmitter)
    service = new LeavingService(
      prisma as unknown as PrismaService,
      history as unknown as MembershipHistoryService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  /** Run the shared procedure inside the fake transaction. */
  const leaveInTransaction = (input: {
    profileId: string;
    companyId: string;
    actorProfileId: string;
    reason: 'LEFT_COMPANY' | 'REMOVED' | 'ACCOUNT_DELETED';
    ownerSuccessorProfileId?: string;
  }) =>
    service.leaveInTransaction(
      tx as unknown as Prisma.TransactionClient,
      input,
    );

  describe('leaveInTransaction: staff or a manager', () => {
    it('locks the company row before anything else, then re-reads the leaver under the lock', async () => {
      await leaveInTransaction({
        profileId: 'park',
        companyId: 'company-1',
        actorProfileId: 'park',
        reason: 'LEFT_COMPANY',
      });

      expect(tx.company.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'company-1' },
        data: { updatedAt: ANY_DATE },
      });
      expect(tx.profile.findFirst).toHaveBeenCalledWith({
        where: { id: 'park', companyId: 'company-1', deletedAt: null },
        select: {
          id: true,
          name: true,
          roleId: true,
          status: true,
          role: { select: { code: true } },
        },
      });
      expect(timeline).toEqual([
        'lock company',
        'read leaver',
        'write park',
        'end assignments of park',
      ]);
    });

    it('deactivates them with a guarded write, then ends their live assignments, stamped with the actor', async () => {
      await leaveInTransaction({
        profileId: 'park',
        companyId: 'company-1',
        actorProfileId: 'park',
        reason: 'LEFT_COMPANY',
      });

      expect(tx.profile.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'park',
          status: {
            in: [ProfileStatus.ACTIVE, ProfileStatus.PENDING_APPROVAL],
          },
          deletedAt: null,
        },
        data: { status: ProfileStatus.DEACTIVATED },
      });
      expect(tx.profileBranch.updateManyAndReturn).toHaveBeenCalledWith({
        where: { profileId: 'park', deletedAt: null },
        data: { deletedAt: ANY_DATE, deletedByProfileId: 'park' },
        select: { companyStoreId: true },
      });
    });

    it('writes one LEFT_COMPANY row per ended assignment: (STAFF, A) and (STAFF, B) → (none, none)', async () => {
      await leaveInTransaction({
        profileId: 'park',
        companyId: 'company-1',
        actorProfileId: 'park',
        reason: 'LEFT_COMPANY',
      });

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          profileId: 'park',
          reason: MembershipChangeReason.LEFT_COMPANY,
          fromRoleId: 4,
          toRoleId: null,
          fromCornerId: 'corner-a',
          toCornerId: null,
          changedByProfileId: 'park',
        },
        {
          companyId: 'company-1',
          profileId: 'park',
          reason: MembershipChangeReason.LEFT_COMPANY,
          fromRoleId: 4,
          toRoleId: null,
          fromCornerId: 'corner-b',
          toCornerId: null,
          changedByProfileId: 'park',
        },
      ]);
    });

    it('someone with no branch gets one row: (STAFF, none) → (none, none)', async () => {
      assignmentsOf.park = [];

      await leaveInTransaction({
        profileId: 'park',
        companyId: 'company-1',
        actorProfileId: 'park',
        reason: 'LEFT_COMPANY',
      });

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          profileId: 'park',
          reason: MembershipChangeReason.LEFT_COMPANY,
          fromRoleId: 4,
          toRoleId: null,
          fromCornerId: null,
          toCornerId: null,
          changedByProfileId: 'park',
        },
      ]);
    });

    it('returns member.left with the branches that just ended, and promotes nobody', async () => {
      const outcome = await leaveInTransaction({
        profileId: 'park',
        companyId: 'company-1',
        actorProfileId: 'park',
        reason: 'LEFT_COMPANY',
      });

      expect(outcome).toEqual({
        summary: { companyClosed: false, newOwner: null },
        events: [
          {
            name: NotificationEvent.MEMBER_LEFT,
            payload: {
              companyId: 'company-1',
              memberProfileId: 'park',
              memberName: 'Park',
              cornerIds: ['corner-a', 'corner-b'],
              reason: 'LEFT_COMPANY',
              changedByProfileId: 'park',
            },
          },
        ],
      });
      expect(tx.profile.count).not.toHaveBeenCalled();
      expect(tx.role.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("a branch's only manager leaving promotes nobody: owners cover the branch", async () => {
      leaverRow = {
        id: 'lee',
        name: 'Lee',
        roleId: 3,
        status: ProfileStatus.ACTIVE,
        role: { code: 'MANAGER' },
      };
      assignmentsOf.lee = [{ companyStoreId: 'corner-a' }];

      const outcome = await leaveInTransaction({
        profileId: 'lee',
        companyId: 'company-1',
        actorProfileId: 'lee',
        reason: 'LEFT_COMPANY',
      });

      expect(outcome.summary.newOwner).toBeNull();
      expect(tx.profile.count).not.toHaveBeenCalled();
      expect(tx.profile.findMany).not.toHaveBeenCalled();
      expect(tx.profile.updateMany).toHaveBeenCalledTimes(1); // only the leaver
    });

    it.each([
      ['LEFT_COMPANY', [ProfileStatus.ACTIVE, ProfileStatus.PENDING_APPROVAL]],
      ['REMOVED', [ProfileStatus.ACTIVE, ProfileStatus.SUSPENDED]],
      [
        'ACCOUNT_DELETED',
        [
          ProfileStatus.PENDING_APPROVAL,
          ProfileStatus.ACTIVE,
          ProfileStatus.SUSPENDED,
          ProfileStatus.REJECTED,
        ],
      ],
    ] as const)(
      '%s accepts only %j in its guarded write',
      async (reason, allowedStatuses) => {
        await leaveInTransaction({
          profileId: 'park',
          companyId: 'company-1',
          actorProfileId: 'park',
          reason: reason,
        });

        expect(tx.profile.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: 'park',
              status: { in: [...allowedStatuses] },
              deletedAt: null,
            },
          }),
        );
      },
    );

    it('a removal names the remover as the actor: changed_by, deleted_by, and in the event', async () => {
      const outcome = await leaveInTransaction({
        profileId: 'park',
        companyId: 'company-1',
        actorProfileId: 'jisoo',
        reason: 'REMOVED',
      });

      expect(tx.profileBranch.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { deletedAt: ANY_DATE, deletedByProfileId: 'jisoo' },
        }),
      );
      expect(history.record).toHaveBeenCalledWith(tx, [
        expect.objectContaining({
          reason: MembershipChangeReason.REMOVED,
          changedByProfileId: 'jisoo',
        }),
        expect.objectContaining({
          reason: MembershipChangeReason.REMOVED,
          changedByProfileId: 'jisoo',
        }),
      ]);
      expect(outcome.events).toEqual([
        {
          name: NotificationEvent.MEMBER_LEFT,
          payload: expect.objectContaining({
            reason: 'REMOVED',
            changedByProfileId: 'jisoo',
          }) as unknown,
        },
      ]);
    });

    it('409 when the guarded write finds them changed: nothing recorded', async () => {
      tx.profile.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        leaveInTransaction({
          profileId: 'park',
          companyId: 'company-1',
          actorProfileId: 'park',
          reason: 'LEFT_COMPANY',
        }),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(history.record).not.toHaveBeenCalled();
    });

    it.each([
      ['gone (another company, or deleted)', null],
      [
        'in a status this way out does not allow (SUSPENDED, leaving)',
        { ...park, status: ProfileStatus.SUSPENDED },
      ],
      [
        'already gone (DEACTIVATED)',
        { ...park, status: ProfileStatus.DEACTIVATED },
      ],
    ])('409 when the re-read finds them %s', async (_label, row) => {
      leaverRow = row;

      await expect(
        leaveInTransaction({
          profileId: 'park',
          companyId: 'company-1',
          actorProfileId: 'park',
          reason: 'LEFT_COMPANY',
        }),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(tx.profile.updateMany).not.toHaveBeenCalled();
    });

    it('a non-owner naming an owner successor is 400: nothing to succeed', async () => {
      await expect(
        leaveInTransaction({
          profileId: 'park',
          companyId: 'company-1',
          actorProfileId: 'park',
          reason: 'LEFT_COMPANY',
          ownerSuccessorProfileId: 'kim',
        }),
      ).rejects.toThrow(
        new BadRequestException('No owner successor is needed'),
      );
      expect(tx.profile.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('leaveInTransaction: an owner', () => {
    beforeEach(() => {
      leaverRow = jisoo;
      candidateRows = [lee, kim];
      assignmentsOf.lee = [{ companyStoreId: 'corner-a' }];
    });

    it('counts the other ACTIVE owners under the lock', async () => {
      await leaveInTransaction({
        profileId: 'jisoo',
        companyId: 'company-1',
        actorProfileId: 'jisoo',
        reason: 'LEFT_COMPANY',
      });

      expect(tx.profile.count).toHaveBeenCalledWith({
        where: {
          companyId: 'company-1',
          id: { not: 'jisoo' },
          role: { code: 'OWNER' },
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
      });
      expect(timeline.indexOf('count owners')).toBeGreaterThan(
        timeline.indexOf('lock company'),
      );
    });

    describe('with another ACTIVE owner', () => {
      beforeEach(() => {
        tx.profile.count.mockResolvedValue(1);
      });

      it('nobody is promoted: one (OWNER, none) row and member.left', async () => {
        const outcome = await leaveInTransaction({
          profileId: 'jisoo',
          companyId: 'company-1',
          actorProfileId: 'jisoo',
          reason: 'LEFT_COMPANY',
        });

        expect(tx.profile.findMany).not.toHaveBeenCalled();
        expect(tx.role.findUniqueOrThrow).not.toHaveBeenCalled();
        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'jisoo',
            reason: MembershipChangeReason.LEFT_COMPANY,
            fromRoleId: 2,
            toRoleId: null,
            fromCornerId: null,
            toCornerId: null,
            changedByProfileId: 'jisoo',
          },
        ]);
        expect(outcome.summary).toEqual({
          companyClosed: false,
          newOwner: null,
        });
        expect(outcome.events.map((event) => event.name)).toEqual([
          NotificationEvent.MEMBER_LEFT,
        ]);
      });

      it('naming a successor anyway is 400: nothing written', async () => {
        await expect(
          leaveInTransaction({
            profileId: 'jisoo',
            companyId: 'company-1',
            actorProfileId: 'jisoo',
            reason: 'LEFT_COMPANY',
            ownerSuccessorProfileId: 'lee',
          }),
        ).rejects.toThrow(
          new BadRequestException('No owner successor is needed'),
        );
        expect(tx.profile.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('the last ACTIVE owner', () => {
      it('reads the candidates: the ACTIVE managers and staff of the company, not the leaver', async () => {
        await leaveInTransaction({
          profileId: 'jisoo',
          companyId: 'company-1',
          actorProfileId: 'jisoo',
          reason: 'LEFT_COMPANY',
        });

        expect(tx.profile.findMany).toHaveBeenCalledWith({
          where: {
            companyId: 'company-1',
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
            id: { not: 'jisoo' },
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
      });

      it('a named successor becomes OWNER through a guarded write, before the leaver goes', async () => {
        const outcome = await leaveInTransaction({
          profileId: 'jisoo',
          companyId: 'company-1',
          actorProfileId: 'jisoo',
          reason: 'LEFT_COMPANY',
          ownerSuccessorProfileId: 'kim',
        });

        expect(tx.role.findUniqueOrThrow).toHaveBeenCalledWith({
          where: { code: 'OWNER' },
        });
        expect(tx.profile.updateMany).toHaveBeenNthCalledWith(1, {
          where: {
            id: 'kim',
            companyId: 'company-1',
            roleId: 4,
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
          },
          data: { roleId: 2 },
        });
        expect(timeline).toEqual([
          'lock company',
          'read leaver',
          'count owners',
          'read candidates',
          'write kim',
          'end assignments of kim',
          'write jisoo',
          'end assignments of jisoo',
        ]);
        expect(outcome.summary).toEqual({
          companyClosed: false,
          newOwner: { profileId: 'kim', name: 'Kim', picked: 'CHOSEN' },
        });
      });

      it('the named successor: ROLE_CHANGED by the leaver, their assignments ended by the leaver, member.roleChanged', async () => {
        assignmentsOf.kim = [{ companyStoreId: 'corner-b' }];

        const outcome = await leaveInTransaction({
          profileId: 'jisoo',
          companyId: 'company-1',
          actorProfileId: 'jisoo',
          reason: 'LEFT_COMPANY',
          ownerSuccessorProfileId: 'kim',
        });

        expect(tx.profileBranch.updateManyAndReturn).toHaveBeenCalledWith({
          where: { profileId: 'kim', deletedAt: null },
          data: { deletedAt: ANY_DATE, deletedByProfileId: 'jisoo' },
          select: { companyStoreId: true },
        });
        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'kim',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 4,
            toRoleId: 2,
            fromCornerId: 'corner-b',
            toCornerId: null,
            changedByProfileId: 'jisoo',
          },
          {
            companyId: 'company-1',
            profileId: 'jisoo',
            reason: MembershipChangeReason.LEFT_COMPANY,
            fromRoleId: 2,
            toRoleId: null,
            fromCornerId: null,
            toCornerId: null,
            changedByProfileId: 'jisoo',
          },
        ]);
        expect(outcome.events).toEqual([
          {
            name: NotificationEvent.MEMBER_ROLE_CHANGED,
            payload: {
              memberProfileId: 'kim',
              changedByProfileId: 'jisoo',
              toRoleCode: 'OWNER',
            },
          },
          {
            name: NotificationEvent.MEMBER_LEFT,
            payload: {
              companyId: 'company-1',
              memberProfileId: 'jisoo',
              memberName: 'Jisoo',
              cornerIds: [],
              reason: 'LEFT_COMPANY',
              changedByProfileId: 'jisoo',
            },
          },
        ]);
      });

      it('none named: pickSuccessor picks the manager over earlier staff; AUTO_PROMOTED by nobody', async () => {
        const outcome = await leaveInTransaction({
          profileId: 'jisoo',
          companyId: 'company-1',
          actorProfileId: 'jisoo',
          reason: 'LEFT_COMPANY',
        });

        expect(tx.profile.updateMany).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            where: expect.objectContaining({ id: 'lee', roleId: 3 }) as unknown,
          }),
        );
        // the system chose: nobody's name goes on the change
        expect(tx.profileBranch.updateManyAndReturn).toHaveBeenCalledWith({
          where: { profileId: 'lee', deletedAt: null },
          data: { deletedAt: ANY_DATE, deletedByProfileId: null },
          select: { companyStoreId: true },
        });
        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'lee',
            reason: MembershipChangeReason.AUTO_PROMOTED,
            fromRoleId: 3,
            toRoleId: 2,
            fromCornerId: 'corner-a',
            toCornerId: null,
            changedByProfileId: null,
          },
          expect.objectContaining({
            profileId: 'jisoo',
            reason: MembershipChangeReason.LEFT_COMPANY,
          }),
        ]);
        expect(outcome.summary.newOwner).toEqual({
          profileId: 'lee',
          name: 'Lee',
          picked: 'AUTO',
        });
        expect(outcome.events[0]).toEqual({
          name: NotificationEvent.MEMBER_ROLE_CHANGED,
          payload: {
            memberProfileId: 'lee',
            changedByProfileId: null,
            toRoleCode: 'OWNER',
          },
        });
      });

      it('409 when the successor changed meanwhile: the leaver stays', async () => {
        tx.profile.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(
          leaveInTransaction({
            profileId: 'jisoo',
            companyId: 'company-1',
            actorProfileId: 'jisoo',
            reason: 'LEFT_COMPANY',
            ownerSuccessorProfileId: 'kim',
          }),
        ).rejects.toThrow(
          new ConflictException('This member was just changed; reload'),
        );
        expect(tx.profile.updateMany).toHaveBeenCalledTimes(1); // the leaver is never written
        expect(history.record).not.toHaveBeenCalled();
      });

      it.each([
        [
          'someone who is not a candidate (pending, an owner, of another company)',
          'stranger',
        ],
        ['the leaver themselves', 'jisoo'],
      ])('400 for %s, and nothing is written', async (_label, successorId) => {
        await expect(
          leaveInTransaction({
            profileId: 'jisoo',
            companyId: 'company-1',
            actorProfileId: 'jisoo',
            reason: 'LEFT_COMPANY',
            ownerSuccessorProfileId: successorId,
          }),
        ).rejects.toThrow(
          new BadRequestException('This person cannot take over as owner'),
        );
        expect(tx.profile.updateMany).not.toHaveBeenCalled();
        expect(history.record).not.toHaveBeenCalled();
      });
    });
  });

  describe('leaveInTransaction: closing the company', () => {
    beforeEach(() => {
      // the last ACTIVE owner, and no ACTIVE member to take over
      leaverRow = jisoo;
      candidateRows = [];
      tx.companyStore.updateManyAndReturn.mockImplementation(() => {
        timeline.push('close branches');
        return Promise.resolve([{ id: 'corner-a' }, { id: 'corner-b' }]);
      });
      // a suspended manager and a waiting newcomer are still on the books
      tx.profile.updateManyAndReturn.mockImplementation(() => {
        timeline.push('deactivate the rest');
        return Promise.resolve([
          { id: 'suspended-lee', roleId: 3 },
          { id: 'waiting-newcomer', roleId: null },
        ]);
      });
      closedBranchAssignments = [
        { profileId: 'suspended-lee', companyStoreId: 'corner-a' },
      ];
    });

    it('soft-deletes the company, its branches and their assignments, stamped with the leaver', async () => {
      await leaveInTransaction({
        profileId: 'jisoo',
        companyId: 'company-1',
        actorProfileId: 'jisoo',
        reason: 'LEFT_COMPANY',
      });

      expect(tx.company.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'company-1', deletedAt: null },
        data: { deletedAt: ANY_DATE, deletedByProfileId: 'jisoo' },
      });
      expect(tx.companyStore.updateManyAndReturn).toHaveBeenCalledWith({
        where: { companyId: 'company-1', deletedAt: null },
        data: { deletedAt: ANY_DATE, deletedByProfileId: 'jisoo' },
        select: { id: true },
      });
      expect(tx.profileBranch.updateManyAndReturn).toHaveBeenCalledWith({
        where: {
          companyStoreId: { in: ['corner-a', 'corner-b'] },
          deletedAt: null,
        },
        data: { deletedAt: ANY_DATE, deletedByProfileId: 'jisoo' },
        select: { profileId: true, companyStoreId: true },
      });
    });

    it('deactivates the leaver (guarded) and every other live profile of the company', async () => {
      await leaveInTransaction({
        profileId: 'jisoo',
        companyId: 'company-1',
        actorProfileId: 'jisoo',
        reason: 'LEFT_COMPANY',
      });

      expect(tx.profile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'jisoo' }) as unknown,
          data: { status: ProfileStatus.DEACTIVATED },
        }),
      );
      expect(tx.profile.updateManyAndReturn).toHaveBeenCalledWith({
        where: {
          companyId: 'company-1',
          id: { not: 'jisoo' },
          deletedAt: null,
          status: { not: ProfileStatus.DEACTIVATED },
        },
        data: { status: ProfileStatus.DEACTIVATED },
        select: { id: true, roleId: true },
      });
    });

    it('takes its locks in the usual order: company, branches, profiles, then assignments', async () => {
      await leaveInTransaction({
        profileId: 'jisoo',
        companyId: 'company-1',
        actorProfileId: 'jisoo',
        reason: 'LEFT_COMPANY',
      });

      expect(timeline).toEqual([
        'lock company',
        'read leaver',
        'count owners',
        'read candidates',
        'close company',
        'close branches',
        'write jisoo',
        'deactivate the rest',
        'end assignments of closed branches',
      ]);
    });

    it('COMPANY_CLOSED rows for the leaver and everyone else who had a role, one per ended assignment', async () => {
      await leaveInTransaction({
        profileId: 'jisoo',
        companyId: 'company-1',
        actorProfileId: 'jisoo',
        reason: 'LEFT_COMPANY',
      });

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          profileId: 'jisoo',
          reason: MembershipChangeReason.COMPANY_CLOSED,
          fromRoleId: 2,
          toRoleId: null,
          fromCornerId: null,
          toCornerId: null,
          changedByProfileId: 'jisoo',
        },
        {
          companyId: 'company-1',
          profileId: 'suspended-lee',
          reason: MembershipChangeReason.COMPANY_CLOSED,
          fromRoleId: 3,
          toRoleId: null,
          fromCornerId: 'corner-a',
          toCornerId: null,
          changedByProfileId: 'jisoo',
        },
      ]);
    });

    it('says the company closed, and tells nobody: nobody is left', async () => {
      const outcome = await leaveInTransaction({
        profileId: 'jisoo',
        companyId: 'company-1',
        actorProfileId: 'jisoo',
        reason: 'LEFT_COMPANY',
      });

      expect(outcome).toEqual({
        summary: { companyClosed: true, newOwner: null },
        events: [],
      });
      expect(tx.role.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('leaveInTransaction: a pending leaver', () => {
    it('a waiting newcomer only becomes DEACTIVATED: no assignments, no history, no events', async () => {
      leaverRow = {
        id: 'newcomer',
        name: 'Newcomer',
        roleId: null,
        status: ProfileStatus.PENDING_APPROVAL,
        role: null,
      };

      const outcome = await leaveInTransaction({
        profileId: 'newcomer',
        companyId: 'company-1',
        actorProfileId: 'newcomer',
        reason: 'LEFT_COMPANY',
      });

      expect(timeline).toEqual([
        'lock company',
        'read leaver',
        'write newcomer',
      ]);
      // record([]) is a no-op (MembershipHistoryService), so check the rows
      const rowsWritten = history.record.mock.calls.flatMap(
        (call: unknown[]) => call[1] as unknown[],
      );
      expect(rowsWritten).toEqual([]);
      expect(outcome).toEqual({
        summary: { companyClosed: false, newOwner: null },
        events: [],
      });
    });

    it('a pending owner withdraws their waiting company: it closes, with no row for them', async () => {
      leaverRow = {
        id: 'founder',
        name: 'Founder',
        roleId: 2,
        status: ProfileStatus.PENDING_APPROVAL,
        role: { code: 'OWNER' },
      };

      const outcome = await leaveInTransaction({
        profileId: 'founder',
        companyId: 'company-1',
        actorProfileId: 'founder',
        reason: 'LEFT_COMPANY',
      });

      expect(tx.profile.count).not.toHaveBeenCalled(); // not an ACTIVE owner
      expect(timeline).toContain('close company');
      const rowsWritten = history.record.mock.calls.flatMap(
        (call: unknown[]) => call[1] as unknown[],
      );
      expect(rowsWritten).toEqual([]);
      expect(outcome).toEqual({
        summary: { companyClosed: true, newOwner: null },
        events: [],
      });
    });
  });

  describe('leave', () => {
    const OUTCOME: LeaveOutcome = {
      summary: {
        companyClosed: false,
        newOwner: { profileId: 'lee', name: 'Lee', picked: 'CHOSEN' },
      },
      events: [
        {
          name: NotificationEvent.MEMBER_ROLE_CHANGED,
          payload: { memberProfileId: 'lee' },
        },
        {
          name: NotificationEvent.MEMBER_LEFT,
          payload: { memberProfileId: 'jisoo' },
        },
      ],
    };

    it('runs the procedure for the caller, as the actor, and sends its events only after the commit', async () => {
      const procedure = jest
        .spyOn(service, 'leaveInTransaction')
        .mockImplementation(() => {
          timeline.push('procedure');
          return Promise.resolve(OUTCOME);
        });

      await expect(
        service.leave(ownerCaller, { ownerSuccessorProfileId: 'lee' }),
      ).resolves.toEqual(OUTCOME.summary);

      expect(procedure).toHaveBeenCalledWith(tx, {
        profileId: 'jisoo',
        companyId: 'company-1',
        actorProfileId: 'jisoo',
        reason: 'LEFT_COMPANY',
        ownerSuccessorProfileId: 'lee',
      });
      expect(eventEmitter.emit).toHaveBeenNthCalledWith(
        1,
        NotificationEvent.MEMBER_ROLE_CHANGED,
        { memberProfileId: 'lee' },
      );
      expect(eventEmitter.emit).toHaveBeenNthCalledWith(
        2,
        NotificationEvent.MEMBER_LEFT,
        { memberProfileId: 'jisoo' },
      );
      expect(timeline).toEqual(['procedure', 'commit', 'emit', 'emit']);
    });

    it('null means nobody named, the same as leaving the field out: the system picks', async () => {
      const procedure = jest
        .spyOn(service, 'leaveInTransaction')
        .mockResolvedValue(OUTCOME);

      await service.leave(ownerCaller, { ownerSuccessorProfileId: null });

      expect(procedure).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ ownerSuccessorProfileId: undefined }),
      );
    });

    it('sends nothing when the procedure throws (the transaction rolled back)', async () => {
      jest
        .spyOn(service, 'leaveInTransaction')
        .mockRejectedValue(
          new ConflictException('This member was just changed; reload'),
        );

      await expect(service.leave(staffCaller, {})).rejects.toThrow(
        ConflictException,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('the platform admin has no company to leave (403)', async () => {
      await expect(service.leave(adminCaller, {})).rejects.toThrow(
        new ForbiddenException('The platform admin has no company to leave'),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('staff need no successor, and the company stays', async () => {
      await expect(service.preview(staffCaller)).resolves.toEqual({
        companyWillClose: false,
        owner: null,
      });
      expect(prisma.profile.count).not.toHaveBeenCalled();
    });

    it("a pending owner's leaving withdraws their waiting company", async () => {
      await expect(
        service.preview({
          ...ownerCaller,
          id: 'founder',
          status: ProfileStatus.PENDING_APPROVAL,
        }),
      ).resolves.toEqual({ companyWillClose: true, owner: null });
    });

    it('an owner with a co-owner needs no successor', async () => {
      prisma.profile.count.mockResolvedValue(1);

      await expect(service.preview(ownerCaller)).resolves.toEqual({
        companyWillClose: false,
        owner: { successorNeeded: false, candidates: [], defaultPick: null },
      });
      expect(prisma.profile.count).toHaveBeenCalledWith({
        where: {
          companyId: 'company-1',
          id: { not: 'jisoo' },
          role: { code: 'OWNER' },
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
      });
      expect(prisma.profile.findMany).not.toHaveBeenCalled();
    });

    it('the last owner sees the candidates, oldest first, and who the system would pick', async () => {
      prisma.profile.count.mockResolvedValue(0);
      prisma.profile.findMany.mockResolvedValue([kim, lee]);

      await expect(service.preview(ownerCaller)).resolves.toEqual({
        companyWillClose: false,
        owner: {
          successorNeeded: true,
          candidates: [
            { profileId: 'kim', name: 'Kim', role: 'STAFF' },
            { profileId: 'lee', name: 'Lee', role: 'MANAGER' },
          ],
          defaultPick: 'lee', // managers first
        },
      });
      expect(prisma.profile.findMany).toHaveBeenCalledWith({
        where: {
          companyId: 'company-1',
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
          id: { not: 'jisoo' },
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
    });

    it('a lone owner: the company would close', async () => {
      prisma.profile.count.mockResolvedValue(0);
      prisma.profile.findMany.mockResolvedValue([]);

      await expect(service.preview(ownerCaller)).resolves.toEqual({
        companyWillClose: true,
        owner: { successorNeeded: true, candidates: [], defaultPick: null },
      });
    });

    it('the platform admin has no company to leave (403)', async () => {
      await expect(service.preview(adminCaller)).rejects.toThrow(
        new ForbiddenException('The platform admin has no company to leave'),
      );
    });
  });
});
