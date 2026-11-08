import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CornersService } from './corners.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { MembershipChangeReason, UserStatus } from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

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
    user: { updateManyAndReturn: jest.Mock };
  };
  let stores: { findActive: jest.Mock };
  let history: { record: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  /** The order things happened in, to prove events fire after commit. */
  let timeline: string[];

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
  };
  const admin: AuthUser = {
    id: 'admin-1',
    companyId: null,
    roleId: 1,
    roleCode: 'ADMIN',
    status: UserStatus.ACTIVE,
  };
  const manager: AuthUser = {
    id: 'mgr-1',
    companyId: 'company-1',
    companyStoreId: 'c1', // the manager's branch
    roleId: 3,
    roleCode: 'MANAGER',
    status: UserStatus.ACTIVE,
  };
  const staff: AuthUser = {
    id: 'staff-1',
    companyId: 'company-1',
    companyStoreId: 'c1',
    roleId: 4,
    roleCode: 'STAFF',
    status: UserStatus.ACTIVE,
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
      user: { updateManyAndReturn: jest.fn().mockResolvedValue([]) },
    };
    stores = { findActive: jest.fn().mockResolvedValue({ id: 'store-1' }) };
    history = { record: jest.fn().mockResolvedValue(undefined) };
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
    const lee = { id: 'lee', roleId: 3 }; // a manager
    const park = { id: 'park', roleId: 4 }; // staff

    beforeEach(() => {
      prisma.companyStore.findFirst.mockResolvedValue(branchA);
      prisma.companyStore.findUniqueOrThrow.mockResolvedValue({
        ...branchA,
        deletedAt: new Date('2026-11-09T00:00:00.000Z'),
      });
      tx.user.updateManyAndReturn.mockResolvedValue([lee, park]);
    });

    it('soft-deletes the branch with a guarded write that stamps the deleter', async () => {
      await service.remove(owner, 'corner-a');

      // scoped to the caller's company first (404 across tenants)
      expect(prisma.companyStore.findFirst).toHaveBeenCalledWith({
        where: { id: 'corner-a', companyId: 'company-1', deletedAt: null },
      });
      expect(tx.companyStore.updateMany).toHaveBeenCalledWith({
        where: { id: 'corner-a', deletedAt: null },
        data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
      });
    });

    it('releases its people in the same statement that reports who was released', async () => {
      await service.remove(owner, 'corner-a');

      expect(tx.user.updateManyAndReturn).toHaveBeenCalledWith({
        where: { companyStoreId: 'corner-a', deletedAt: null },
        data: { companyStoreId: null },
        select: { id: true, roleId: true },
      });
    });

    it('writes one BRANCH_DELETED snapshot row per released person, and only for them', async () => {
      await service.remove(owner, 'corner-a');

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          userId: 'lee',
          reason: MembershipChangeReason.BRANCH_DELETED,
          fromRoleId: 3,
          toRoleId: 3,
          fromCornerId: 'corner-a',
          toCornerId: null,
          changedByUserId: 'owner-1',
        },
        {
          companyId: 'company-1',
          userId: 'park',
          reason: MembershipChangeReason.BRANCH_DELETED,
          fromRoleId: 4,
          toRoleId: 4,
          fromCornerId: 'corner-a',
          toCornerId: null,
          changedByUserId: 'owner-1',
        },
      ]);
    });

    it('notifies each released person, only after the transaction commits', async () => {
      await service.remove(owner, 'corner-a');

      for (const memberUserId of ['lee', 'park']) {
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          NotificationEvent.MEMBER_MOVED,
          {
            memberUserId: memberUserId,
            changedByUserId: 'owner-1',
            fromCornerId: 'corner-a',
            toCornerId: null,
            reason: 'BRANCH_DELETED',
          },
        );
      }
      expect(timeline).toEqual(['commit', 'emit', 'emit']);
    });

    it('someone who left a moment earlier is not in the receipt: no history row, no message', async () => {
      // Lee was moved to another branch before the release statement ran
      tx.user.updateManyAndReturn.mockResolvedValue([park]);

      await service.remove(owner, 'corner-a');

      expect(history.record.mock.calls[0][1]).toHaveLength(1);
      expect(history.record.mock.calls[0][1][0]).toMatchObject({
        userId: 'park',
      });
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    });

    it('an empty branch: no history rows, no notifications', async () => {
      tx.user.updateManyAndReturn.mockResolvedValue([]);

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

    it('404 when someone deleted it a moment ago: nobody released, nothing sent', async () => {
      tx.companyStore.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.remove(owner, 'corner-a')).rejects.toThrow(
        new NotFoundException('Corner not found'),
      );
      expect(tx.user.updateManyAndReturn).not.toHaveBeenCalled();
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

    it('lets a MANAGER through their own branch', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(service.assertWorksCorner(manager, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a MANAGER on a branch that is not theirs', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c2'));
      await expect(service.assertWorksCorner(manager, 'c2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('403s a MANAGER who has no branch, on every branch', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(
        service.assertWorksCorner({ ...manager, companyStoreId: null }, 'c1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets the STAFF member assigned to the corner through', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c1'));
      await expect(service.assertWorksCorner(staff, 'c1')).resolves.toEqual(
        expect.objectContaining({ id: 'c1' }),
      );
    });

    it('403s a STAFF member not assigned to the corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c2'));
      await expect(service.assertWorksCorner(staff, 'c2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lets an OWNER through any corner', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(cornerRow('c9'));
      await expect(service.assertWorksCorner(owner, 'c9')).resolves.toEqual(
        expect.objectContaining({ id: 'c9' }),
      );
    });

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
});
