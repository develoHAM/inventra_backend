import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CornersService } from './corners.service';
import { OwnershipService } from '../authorization/ownership.service';
import type { AuthProfile } from '../auth/types/auth-profile';
import {
  MembershipChangeReason,
  ProfileStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

/** "Some Date": the moment a row was stamped isn't what these tests check. */
const ANY_DATE: unknown = expect.any(Date);

describe('CornersService', () => {
  let service: CornersService;
  let prisma: {
    companyStore: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let tx: {
    companyStore: { updateMany: jest.Mock };
    profileBranch: { updateManyAndReturn: jest.Mock };
    profile: { findMany: jest.Mock };
  };
  let stores: { findActive: jest.Mock };
  let history: { record: jest.Mock; page: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  /** The order things happened in, to prove events fire after commit. */
  let timeline: string[];

  const owner: AuthProfile = {
    id: 'owner-1',
    accountId: 'account-of-owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    branchIds: [],
    status: ProfileStatus.ACTIVE,
  };
  const admin: AuthProfile = {
    id: 'admin-1',
    accountId: 'account-of-admin-1',
    companyId: null,
    roleId: 1,
    roleCode: 'ADMIN',
    branchIds: [],
    status: ProfileStatus.ACTIVE,
  };
  const manager: AuthProfile = {
    id: 'mgr-1',
    accountId: 'account-of-mgr-1',
    companyId: 'company-1',
    roleId: 3,
    roleCode: 'MANAGER',
    branchIds: ['c1'], // the manager works in c1
    status: ProfileStatus.ACTIVE,
  };
  const staff: AuthProfile = {
    id: 'staff-1',
    accountId: 'account-of-staff-1',
    companyId: 'company-1',
    roleId: 4,
    roleCode: 'STAFF',
    branchIds: ['c1'],
    status: ProfileStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      companyStore: {
        create: jest.fn().mockResolvedValue({ id: 'corner-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn(),
      },
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) => {
        const result = await callback(tx);
        timeline.push('commit');
        return result;
      }),
    };
    timeline = [];
    tx = {
      companyStore: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      profileBranch: { updateManyAndReturn: jest.fn().mockResolvedValue([]) },
      profile: { findMany: jest.fn().mockResolvedValue([]) },
    };
    stores = { findActive: jest.fn().mockResolvedValue({ id: 'store-1' }) };
    history = {
      record: jest.fn().mockResolvedValue(undefined),
      page: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    eventEmitter = {
      emit: jest.fn(() => {
        timeline.push('emit');
        return true;
      }),
    };
    // constructor order: (prisma, ownership, stores, history, eventEmitter)
    service = new CornersService(
      prisma as any,
      new OwnershipService(),
      stores as any,
      history as any,
      eventEmitter as any,
    );
  });

  describe('create', () => {
    it('creates a corner owned by the caller company after validating the store', async () => {
      await service.create(owner, { storeId: 'store-1', name: 'A1' } as any);

      expect(stores.findActive).toHaveBeenCalledWith('store-1');
      expect(prisma.companyStore.create).toHaveBeenCalledWith({
        data: {
          storeId: 'store-1',
          name: 'A1',
          companyId: 'company-1',
        },
      });
    });

    it('rejects an invalid store with 400', async () => {
      stores.findActive.mockResolvedValue(null);
      await expect(
        service.create(owner, { storeId: 'bad' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.companyStore.create).not.toHaveBeenCalled();
    });

    it('lets ADMIN create for a supplied companyId', async () => {
      await service.create(admin, {
        storeId: 'store-1',
        companyId: 'company-9',
      } as any);

      expect(prisma.companyStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ companyId: 'company-9' }),
        }),
      );
    });

    it('rejects ADMIN create without a companyId (400)', async () => {
      await expect(
        service.create(admin, { storeId: 'store-1' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne', () => {
    it('404s a cross-tenant / absent corner and scopes the lookup', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(null);

      await expect(service.findOne(owner, 'x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.companyStore.findFirst).toHaveBeenCalledWith({
        where: { id: 'x', companyId: 'company-1', deletedAt: null },
      });
    });
  });

  describe('remove', () => {
    const branchA = { id: 'corner-a', companyId: 'company-1' };
    // Lee (a manager) and Park (staff) work in Branch A
    const leeInA = { profileId: 'lee' };
    const parkInA = { profileId: 'park' };

    beforeEach(() => {
      prisma.companyStore.findFirst.mockResolvedValue(branchA);
      prisma.companyStore.findUniqueOrThrow.mockResolvedValue({
        ...branchA,
        deletedAt: new Date('2026-11-09T00:00:00.000Z'),
      });
      tx.profileBranch.updateManyAndReturn.mockResolvedValue([leeInA, parkInA]);
      tx.profile.findMany.mockResolvedValue([
        { id: 'lee', roleId: 3 },
        { id: 'park', roleId: 4 },
      ]);
    });

    it('soft-deletes the branch with a guarded write that stamps the deleter', async () => {
      await service.remove(owner, 'corner-a');

      // scoped to the caller's company first (404 across tenants)
      expect(prisma.companyStore.findFirst).toHaveBeenCalledWith({
        where: { id: 'corner-a', companyId: 'company-1', deletedAt: null },
      });
      expect(tx.companyStore.updateMany).toHaveBeenCalledWith({
        where: { id: 'corner-a', deletedAt: null },
        data: { deletedAt: expect.any(Date), deletedByProfileId: 'owner-1' },
      });
    });

    it('ends its live assignments in the same statement that reports which it ended', async () => {
      await service.remove(owner, 'corner-a');

      expect(tx.profileBranch.updateManyAndReturn).toHaveBeenCalledWith({
        where: { companyStoreId: 'corner-a', deletedAt: null },
        data: { deletedAt: ANY_DATE, deletedByProfileId: 'owner-1' },
        select: { profileId: true },
      });
    });

    it("reads the people's roles for the history, and never writes a profile: nobody's role changes", async () => {
      await service.remove(owner, 'corner-a');

      expect(tx.profile.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['lee', 'park'] } },
        select: { id: true, roleId: true },
      });
      // tx.profile has only findMany: any profile write would throw here
    });

    it('writes one BRANCH_DELETED snapshot row per ended assignment: (role, A) → (same role, no branch)', async () => {
      await service.remove(owner, 'corner-a');

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          profileId: 'lee',
          reason: MembershipChangeReason.BRANCH_DELETED,
          fromRoleId: 3,
          toRoleId: 3,
          fromCornerId: 'corner-a',
          toCornerId: null,
          changedByProfileId: 'owner-1',
        },
        {
          companyId: 'company-1',
          profileId: 'park',
          reason: MembershipChangeReason.BRANCH_DELETED,
          fromRoleId: 4,
          toRoleId: 4,
          fromCornerId: 'corner-a',
          toCornerId: null,
          changedByProfileId: 'owner-1',
        },
      ]);
    });

    it('notifies each person whose assignment ended, only after the transaction commits', async () => {
      await service.remove(owner, 'corner-a');

      for (const memberProfileId of ['lee', 'park']) {
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          NotificationEvent.MEMBER_MOVED,
          {
            memberProfileId: memberProfileId,
            changedByProfileId: 'owner-1',
            cornerId: 'corner-a',
            change: 'BRANCH_DELETED',
          },
        );
      }
      expect(timeline).toEqual(['commit', 'emit', 'emit']);
    });

    it('someone removed from the branch a moment earlier is not in the receipt: no history row, no message', async () => {
      // Lee's assignment was ended before the statement ran
      tx.profileBranch.updateManyAndReturn.mockResolvedValue([parkInA]);
      tx.profile.findMany.mockResolvedValue([{ id: 'park', roleId: 4 }]);

      await service.remove(owner, 'corner-a');

      expect(history.record.mock.calls[0][1]).toHaveLength(1);
      expect(history.record.mock.calls[0][1][0]).toMatchObject({
        profileId: 'park',
      });
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    });

    it('an empty branch: no history rows, no notifications', async () => {
      tx.profileBranch.updateManyAndReturn.mockResolvedValue([]);
      tx.profile.findMany.mockResolvedValue([]);

      await service.remove(owner, 'corner-a');

      // record([]) is a no-op (MembershipHistoryService), so check the rows
      const rowsWritten = history.record.mock.calls.flatMap(
        (call: unknown[]) => call[1] as unknown[],
      );
      expect(rowsWritten).toEqual([]);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('returns the deleted branch', async () => {
      await expect(service.remove(owner, 'corner-a')).resolves.toMatchObject({
        id: 'corner-a',
        deletedAt: expect.any(Date),
      });
      expect(prisma.companyStore.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'corner-a' },
      });
    });

    it('404 when someone deleted it a moment ago: no assignment ended, nothing sent', async () => {
      tx.companyStore.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.remove(owner, 'corner-a')).rejects.toThrow(
        new NotFoundException('Corner not found'),
      );
      expect(tx.profileBranch.updateManyAndReturn).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('404 for a branch of another company, before any write', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(null);

      await expect(service.remove(owner, 'corner-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('assertWorksCorner', () => {
    const cornerRow = (id: string) => ({ id: id, companyId: 'company-1' });
    const NOT_YOURS = new ForbiddenException(
      'You can only work in your own branches',
    );

    it('lets a MANAGER through a branch they work in', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(service.assertWorksCorner(manager, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a MANAGER on a branch they do not work in', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c2'));
      await expect(service.assertWorksCorner(manager, 'c2')).rejects.toThrow(
        NOT_YOURS,
      );
    });

    it('403s a MANAGER who has no branch, on every branch', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(
        service.assertWorksCorner({ ...manager, branchIds: [] }, 'c1'),
      ).rejects.toThrow(NOT_YOURS);
    });

    it('lets the STAFF member who works in the corner through', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(service.assertWorksCorner(staff, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a STAFF member who does not work in the corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c2'));
      await expect(service.assertWorksCorner(staff, 'c2')).rejects.toThrow(
        NOT_YOURS,
      );
    });

    describe('someone in two branches (Review Focus 1)', () => {
      const staffInTwoBranches: AuthProfile = {
        id: 'staff-1',
        accountId: 'account-of-staff-1',
        companyId: 'company-1',
        roleId: 4,
        roleCode: 'STAFF',
        branchIds: ['c1', 'c2'],
        status: ProfileStatus.ACTIVE,
      };

      it.each(['c1', 'c2'])('works in %s', async (cornerId) => {
        prisma.companyStore.findFirst.mockResolvedValue(cornerRow(cornerId));
        await expect(
          service.assertWorksCorner(staffInTwoBranches, cornerId),
        ).resolves.toEqual(expect.objectContaining({ id: cornerId }));
      });

      it('is refused a third one', async () => {
        prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c3'));
        await expect(
          service.assertWorksCorner(staffInTwoBranches, 'c3'),
        ).rejects.toThrow(NOT_YOURS);
      });
    });

    it.each([
      ['an OWNER', owner],
      ['the ADMIN', admin],
    ])(
      'lets %s through any corner, with no assignments',
      async (_label, caller) => {
        prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c9'));
        await expect(service.assertWorksCorner(caller, 'c9')).resolves.toEqual(
          expect.objectContaining({ id: 'c9' }),
        );
      },
    );

    it('404s a cross-tenant / absent corner before any role check', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(null);
      await expect(service.assertWorksCorner(manager, 'c1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('lockLiveCorner', () => {
    it("writes the live corner's row (taking its lock) and reports that it exists", async () => {
      const transaction = {
        companyStore: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      await expect(
        service.lockLiveCorner(transaction as any, 'corner-b', 'company-1'),
      ).resolves.toBe(true);
      expect(transaction.companyStore.updateMany).toHaveBeenCalledWith({
        where: { id: 'corner-b', companyId: 'company-1', deletedAt: null },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it('reports false for a corner that is deleted or in another company', async () => {
      const transaction = {
        companyStore: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };

      await expect(
        service.lockLiveCorner(transaction as any, 'corner-x', 'company-1'),
      ).resolves.toBe(false);
    });
  });

  describe('listHistory', () => {
    const QUERY = { limit: 20 };
    const PAGE = { items: [], nextCursor: null };
    // Departures and arrivals: the branch is the "from" or the "to".
    const BRANCH_ROWS = {
      OR: [{ fromCompanyStoreId: 'c1' }, { toCompanyStoreId: 'c1' }],
    };

    beforeEach(() => {
      prisma.companyStore.findFirst.mockResolvedValue({
        id: 'c1',
        companyId: 'company-1',
        name: 'Branch A',
      });
      history.page.mockResolvedValue(PAGE);
    });

    it('an owner reads every row the branch is in, as the "from" or the "to"', async () => {
      await expect(service.listHistory(owner, 'c1', QUERY)).resolves.toBe(PAGE);

      expect(history.page).toHaveBeenCalledWith(BRANCH_ROWS, QUERY);
    });

    it('the admin reads a branch of any company', async () => {
      await service.listHistory(admin, 'c1', QUERY);

      expect(prisma.companyStore.findFirst).toHaveBeenCalledWith({
        where: { id: 'c1', deletedAt: null },
      });
      expect(history.page).toHaveBeenCalledWith(BRANCH_ROWS, QUERY);
    });

    it('a manager reads the history of a branch they work in', async () => {
      await service.listHistory(manager, 'c1', QUERY);

      expect(history.page).toHaveBeenCalledWith(BRANCH_ROWS, QUERY);
    });

    it('a manager in two branches reads either one', async () => {
      const managerOfTwoBranches = { ...manager, branchIds: ['c2', 'c1'] };

      await service.listHistory(managerOfTwoBranches, 'c1', QUERY);

      expect(history.page).toHaveBeenCalledWith(BRANCH_ROWS, QUERY);
    });

    it("a manager cannot read another branch's history (403)", async () => {
      const managerOfOtherBranch = { ...manager, branchIds: ['c2'] };

      await expect(
        service.listHistory(managerOfOtherBranch, 'c1', QUERY),
      ).rejects.toThrow(ForbiddenException);
      expect(history.page).not.toHaveBeenCalled();
    });

    it('a manager with no branch reads no branch (403)', async () => {
      const managerWithoutBranch = { ...manager, branchIds: [] };

      await expect(
        service.listHistory(managerWithoutBranch, 'c1', QUERY),
      ).rejects.toThrow(ForbiddenException);
    });

    it("staff cannot read branch history, even their own branch's (403)", async () => {
      await expect(service.listHistory(staff, 'c1', QUERY)).rejects.toThrow(
        ForbiddenException,
      );
      expect(history.page).not.toHaveBeenCalled();
    });

    it('a branch outside the company, or deleted, is 404 before any role check', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(null);

      await expect(service.listHistory(staff, 'c1', QUERY)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.companyStore.findFirst).toHaveBeenCalledWith({
        where: { id: 'c1', companyId: 'company-1', deletedAt: null },
      });
    });
  });
});
