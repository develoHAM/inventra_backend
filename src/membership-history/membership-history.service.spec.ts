import { BadRequestException } from '@nestjs/common';
import { MembershipHistoryService } from './membership-history.service';
import type { MembershipChangeInput } from './membership-change';
import { MEMBERSHIP_CHANGE_SELECT } from './membership-change-view';
import { MembershipChangeReason } from '../generated/prisma/enums';

describe('MembershipHistoryService', () => {
  let service: MembershipHistoryService;
  let prisma: {
    membershipChange: { findMany: jest.Mock; findFirst: jest.Mock };
  };
  let transaction: { membershipChange: { createMany: jest.Mock } };

  const staffMovedFromAToB: MembershipChangeInput = {
    companyId: 'company-1',
    profileId: 'staff-1',
    reason: MembershipChangeReason.MOVED,
    fromRoleId: 4,
    toRoleId: 4,
    fromCornerId: 'corner-a',
    toCornerId: 'corner-b',
    changedByProfileId: 'owner-1',
  };
  const managerPromotedToOwner: MembershipChangeInput = {
    companyId: 'company-1',
    profileId: 'manager-1',
    reason: MembershipChangeReason.ROLE_CHANGED,
    fromRoleId: 3,
    toRoleId: 2,
    fromCornerId: 'corner-a',
    toCornerId: null,
    changedByProfileId: null,
  };

  beforeEach(() => {
    prisma = {
      membershipChange: {
        findMany: jest.fn().mockResolvedValue([]),
        // the bookmark lookup: found in this feed by default
        findFirst: jest.fn().mockResolvedValue({ id: 'change-3' }),
      },
    };
    transaction = {
      membershipChange: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    service = new MembershipHistoryService(prisma as any);
  });

  describe('record', () => {
    it('writes every change in one createMany, naming the branch columns', async () => {
      await service.record(transaction as any, [
        staffMovedFromAToB,
        managerPromotedToOwner,
      ]);

      expect(transaction.membershipChange.createMany).toHaveBeenCalledTimes(1);
      expect(transaction.membershipChange.createMany).toHaveBeenCalledWith({
        data: [
          {
            companyId: 'company-1',
            profileId: 'staff-1',
            reason: MembershipChangeReason.MOVED,
            fromRoleId: 4,
            toRoleId: 4,
            fromCompanyStoreId: 'corner-a',
            toCompanyStoreId: 'corner-b',
            changedByProfileId: 'owner-1',
          },
          {
            companyId: 'company-1',
            profileId: 'manager-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 3,
            toRoleId: 2,
            fromCompanyStoreId: 'corner-a',
            toCompanyStoreId: null,
            changedByProfileId: null,
          },
        ],
      });
    });

    it('writes nothing when there are no changes', async () => {
      await service.record(transaction as any, []);

      expect(transaction.membershipChange.createMany).not.toHaveBeenCalled();
    });
  });

  describe('page', () => {
    const WHERE = { companyId: 'company-1' };
    const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }];

    /** A history row as page() selects it: a manager promoting staff in Branch A. */
    const changeRow = (
      id: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: id,
      reason: MembershipChangeReason.ROLE_CHANGED,
      createdAt: new Date('2026-11-09T10:00:00.000Z'),
      profile: { id: 'staff-1', name: 'Kim' },
      changedByProfile: { id: 'manager-1', name: 'Lee' },
      fromRole: { code: 'STAFF', name: 'Staff' },
      toRole: { code: 'MANAGER', name: 'Manager' },
      fromCompanyStore: { id: 'corner-a', name: 'Branch A' },
      toCompanyStore: { id: 'corner-a', name: 'Branch A' },
      ...overrides,
    });
    /** change-1 (newest) … change-N, as the database returns them. */
    const rows = (count: number) =>
      Array.from({ length: count }, (_unused, index) =>
        changeRow(`change-${index + 1}`),
      );

    it('the first page: newest first, ties broken by id, 50 by default plus one to peek', async () => {
      await service.page(WHERE, {});

      expect(prisma.membershipChange.findMany).toHaveBeenCalledWith({
        where: WHERE,
        orderBy: NEWEST_FIRST,
        take: 51,
        select: MEMBERSHIP_CHANGE_SELECT,
      });
    });

    it('a later page starts at the bookmarked entry and steps over it', async () => {
      await service.page(WHERE, { limit: 3, cursor: 'change-3' });

      expect(prisma.membershipChange.findMany).toHaveBeenCalledWith({
        where: WHERE,
        orderBy: NEWEST_FIRST,
        take: 4,
        cursor: { id: 'change-3' },
        skip: 1,
        select: MEMBERSHIP_CHANGE_SELECT,
      });
    });

    it('first checks the bookmark is in this feed, keeping both conditions with AND', async () => {
      await service.page(WHERE, { limit: 3, cursor: 'change-3' });

      expect(prisma.membershipChange.findFirst).toHaveBeenCalledWith({
        where: { AND: [WHERE, { id: 'change-3' }] },
        select: { id: true },
      });
    });

    it('a bookmark that is not in this feed is 400, and nothing is listed', async () => {
      // an unknown id, or one taken from another feed
      prisma.membershipChange.findFirst.mockResolvedValue(null);

      await expect(
        service.page(WHERE, { limit: 3, cursor: 'change-from-elsewhere' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.membershipChange.findMany).not.toHaveBeenCalled();
    });

    it('the first page has no bookmark to check', async () => {
      await service.page(WHERE, {});

      expect(prisma.membershipChange.findFirst).not.toHaveBeenCalled();
    });

    it('one row more than the limit: shows the limit, and the bookmark is the last one shown', async () => {
      prisma.membershipChange.findMany.mockResolvedValue(rows(4));

      const page = await service.page(WHERE, { limit: 3 });

      expect(page.items.map((item) => item.id)).toEqual([
        'change-1',
        'change-2',
        'change-3',
      ]);
      expect(page.nextCursor).toBe('change-3');
    });

    it('no row to peek at: this is the last page', async () => {
      prisma.membershipChange.findMany.mockResolvedValue(rows(3));

      const page = await service.page(WHERE, { limit: 3 });

      expect(page.items).toHaveLength(3);
      expect(page.nextCursor).toBeNull();
    });

    it('nothing at all: an empty last page', async () => {
      await expect(service.page(WHERE, {})).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it('names each part the way the screen reads it', async () => {
      prisma.membershipChange.findMany.mockResolvedValue([
        changeRow('change-1'),
      ]);

      const page = await service.page(WHERE, {});

      expect(page.items[0]).toEqual({
        id: 'change-1',
        reason: MembershipChangeReason.ROLE_CHANGED,
        createdAt: new Date('2026-11-09T10:00:00.000Z'),
        member: { id: 'staff-1', name: 'Kim' },
        changedBy: { id: 'manager-1', name: 'Lee' },
        fromRole: { code: 'STAFF', name: 'Staff' },
        toRole: { code: 'MANAGER', name: 'Manager' },
        fromBranch: { id: 'corner-a', name: 'Branch A' },
        toBranch: { id: 'corner-a', name: 'Branch A' },
      });
    });

    it('an approval has no "from" role or branch', async () => {
      prisma.membershipChange.findMany.mockResolvedValue([
        changeRow('change-1', {
          reason: MembershipChangeReason.APPROVED,
          fromRole: null,
          fromCompanyStore: null,
        }),
      ]);

      const [approval] = (await service.page(WHERE, {})).items;

      expect(approval).toMatchObject({ fromRole: null, fromBranch: null });
    });

    it('a change the system made has no changedBy', async () => {
      prisma.membershipChange.findMany.mockResolvedValue([
        changeRow('change-1', { changedByProfile: null }),
      ]);

      const [change] = (await service.page(WHERE, {})).items;

      expect(change.changedBy).toBeNull();
    });

    it('reads only the id and name of the people and branches involved, never phone or email', () => {
      for (const relation of [
        MEMBERSHIP_CHANGE_SELECT.profile,
        MEMBERSHIP_CHANGE_SELECT.changedByProfile,
        MEMBERSHIP_CHANGE_SELECT.fromCompanyStore,
        MEMBERSHIP_CHANGE_SELECT.toCompanyStore,
      ]) {
        expect(relation).toEqual({ select: { id: true, name: true } });
      }
    });
  });
});
