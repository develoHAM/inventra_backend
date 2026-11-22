import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProfileBranchesService } from './profile-branches.service';
import { ProfilesService } from './profiles.service';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { MembershipHistoryService } from '../membership-history/membership-history.service';
import type { AuthProfile } from '../auth/types/auth-profile';
import {
  MembershipChangeReason,
  ProfileStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

/** "Some Date": the moment a row was stamped isn't what these tests check. */
const ANY_DATE: unknown = expect.any(Date);

describe('ProfileBranchesService', () => {
  let service: ProfileBranchesService;
  let tx: {
    profile: { updateMany: jest.Mock };
    profileBranch: {
      createManyAndReturn: jest.Mock;
      updateManyAndReturn: jest.Mock;
    };
  };
  let prisma: { $transaction: jest.Mock };
  let profiles: { findMember: jest.Mock; viewOf: jest.Mock };
  let corners: { lockLiveCorner: jest.Mock };
  let history: { record: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  /** The order things happened in: locks, writes, the commit, the events. */
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
    id: 'manager-1',
    accountId: 'account-of-staff-1',
    companyId: 'company-1',
    roleId: 3,
    roleCode: 'MANAGER',
    branchIds: ['corner-a'],
    status: ProfileStatus.ACTIVE,
  };
  const staffCaller: AuthProfile = {
    id: 'staff-9',
    accountId: 'account-of-staff-1',
    companyId: 'company-1',
    roleId: 4,
    roleCode: 'STAFF',
    branchIds: ['corner-a'],
    status: ProfileStatus.ACTIVE,
  };

  /** What ProfilesService.findMember returns: staff-1, an active staff member. */
  const member = (overrides: Record<string, unknown> = {}) => ({
    id: 'staff-1',
    companyId: 'company-1',
    roleId: 4,
    roleCode: 'STAFF',
    status: ProfileStatus.ACTIVE,
    ...overrides,
  });
  const VIEW = { id: 'staff-1', branches: [] };

  beforeEach(() => {
    timeline = [];
    tx = {
      profile: {
        updateMany: jest.fn().mockImplementation(() => {
          timeline.push('lock member');
          return Promise.resolve({ count: 1 });
        }),
      },
      profileBranch: {
        createManyAndReturn: jest.fn().mockImplementation(() => {
          timeline.push('assign');
          return Promise.resolve([{ id: 'assignment-1' }]);
        }),
        updateManyAndReturn: jest.fn().mockImplementation(() => {
          timeline.push('end assignment');
          return Promise.resolve([{ id: 'assignment-1' }]);
        }),
      },
    };
    prisma = {
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) => {
        const result = await callback(tx);
        timeline.push('commit');
        return result;
      }),
    };
    profiles = {
      findMember: jest.fn().mockResolvedValue(member()),
      viewOf: jest.fn().mockResolvedValue(VIEW),
    };
    corners = {
      lockLiveCorner: jest.fn().mockImplementation(() => {
        timeline.push('lock branch');
        return Promise.resolve(true);
      }),
    };
    history = { record: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = {
      emit: jest.fn(() => {
        timeline.push('emit');
        return true;
      }),
    };
    // constructor order: (prisma, profiles, corners, history, eventEmitter)
    service = new ProfileBranchesService(
      prisma as unknown as PrismaService,
      profiles as unknown as ProfilesService,
      corners as unknown as CornersService,
      history as unknown as MembershipHistoryService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('add', () => {
    it('locks the branch, then the member, then starts one assignment', async () => {
      await service.add(owner, 'staff-1', { cornerId: 'corner-b' });

      expect(profiles.findMember).toHaveBeenCalledWith(owner, 'staff-1');
      expect(corners.lockLiveCorner).toHaveBeenCalledWith(
        tx,
        'corner-b',
        'company-1',
      );
      expect(tx.profile.updateMany).toHaveBeenCalledWith({
        // the member's row, written only if they're still who we read
        where: {
          id: 'staff-1',
          companyId: 'company-1',
          roleId: 4,
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
        data: { updatedAt: ANY_DATE },
      });
      expect(tx.profileBranch.createManyAndReturn).toHaveBeenCalledWith({
        data: [{ profileId: 'staff-1', companyStoreId: 'corner-b' }],
        skipDuplicates: true,
        select: { id: true },
      });
      expect(timeline).toEqual([
        'lock branch',
        'lock member',
        'assign',
        'commit',
        'emit',
      ]);
    });

    it('writes one BRANCH_ADDED row: (role, no branch) → (same role, the branch)', async () => {
      await service.add(owner, 'staff-1', { cornerId: 'corner-b' });

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          profileId: 'staff-1',
          reason: MembershipChangeReason.BRANCH_ADDED,
          fromRoleId: 4,
          toRoleId: 4,
          fromCornerId: null,
          toCornerId: 'corner-b',
          changedByProfileId: 'owner-1',
        },
      ]);
    });

    it('emits member.moved (ADDED) after the commit, and returns the fresh view', async () => {
      await expect(
        service.add(owner, 'staff-1', { cornerId: 'corner-b' }),
      ).resolves.toBe(VIEW);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_MOVED,
        {
          memberProfileId: 'staff-1',
          changedByProfileId: 'owner-1',
          cornerId: 'corner-b',
          change: 'ADDED',
        },
      );
      expect(profiles.viewOf).toHaveBeenCalledWith('staff-1');
    });

    it("lets the admin add a member of any company, into that member's company", async () => {
      profiles.findMember.mockResolvedValue(member({ companyId: 'company-9' }));

      await service.add(admin, 'staff-1', { cornerId: 'corner-b' });

      expect(profiles.findMember).toHaveBeenCalledWith(admin, 'staff-1');
      expect(corners.lockLiveCorner).toHaveBeenCalledWith(
        tx,
        'corner-b',
        'company-9',
      );
    });

    it('409 when they already work there: the insert is skipped, nothing recorded or sent', async () => {
      tx.profileBranch.createManyAndReturn.mockResolvedValue([]);

      await expect(
        service.add(owner, 'staff-1', { cornerId: 'corner-a' }),
      ).rejects.toThrow(new ConflictException('Already in this branch'));
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('404 when the branch is not a live corner of their company: nothing written', async () => {
      corners.lockLiveCorner.mockResolvedValue(false);

      await expect(
        service.add(owner, 'staff-1', { cornerId: 'corner-x' }),
      ).rejects.toThrow(new NotFoundException('Branch not found'));
      expect(tx.profile.updateMany).not.toHaveBeenCalled();
      expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('409 when the member changed after we read them (e.g. just made an owner): no assignment', async () => {
      tx.profile.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.add(owner, 'staff-1', { cornerId: 'corner-b' }),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    describe('refusals (no transaction, nothing sent)', () => {
      const expectNothingChanged = () => {
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      };

      it('404 when they are not a member the caller can see', async () => {
        profiles.findMember.mockResolvedValue(null);

        await expect(
          service.add(owner, 'staff-1', { cornerId: 'corner-b' }),
        ).rejects.toThrow(new NotFoundException('Member not found'));
        expectNothingChanged();
      });

      it('400 for a member who is not active', async () => {
        profiles.findMember.mockResolvedValue(
          member({ status: ProfileStatus.SUSPENDED }),
        );

        await expect(
          service.add(owner, 'staff-1', { cornerId: 'corner-b' }),
        ).rejects.toThrow(
          new BadRequestException('Only active members can be changed'),
        );
        expectNothingChanged();
      });

      it('400 for an owner: owners work in every branch', async () => {
        profiles.findMember.mockResolvedValue(
          member({ id: 'owner-2', roleId: 2, roleCode: 'OWNER' }),
        );

        await expect(
          service.add(owner, 'owner-2', { cornerId: 'corner-b' }),
        ).rejects.toThrow(
          new BadRequestException('Owners work across the whole company'),
        );
        expectNothingChanged();
      });

      it.each([
        ['a MANAGER', manager],
        ['a STAFF member', staffCaller],
      ])(
        '403 for %s caller, even one granted profiles.move',
        async (_label, caller) => {
          await expect(
            service.add(caller, 'staff-1', { cornerId: 'corner-a' }),
          ).rejects.toThrow(
            new ForbiddenException(
              'Only an owner can change branch assignments',
            ),
          );
          expect(profiles.findMember).not.toHaveBeenCalled();
          expectNothingChanged();
        },
      );
    });
  });

  describe('remove', () => {
    it('locks the member, then ends the live assignment with a guarded write', async () => {
      await service.remove(owner, 'staff-1', 'corner-a');

      expect(tx.profile.updateMany).toHaveBeenCalledWith({
        // the member's row, written only if they're still who we read
        where: {
          id: 'staff-1',
          companyId: 'company-1',
          roleId: 4,
          status: ProfileStatus.ACTIVE,
          deletedAt: null,
        },
        data: { updatedAt: ANY_DATE },
      });
      expect(tx.profileBranch.updateManyAndReturn).toHaveBeenCalledWith({
        where: {
          profileId: 'staff-1',
          companyStoreId: 'corner-a',
          deletedAt: null,
        },
        data: { deletedAt: ANY_DATE, deletedByProfileId: 'owner-1' },
        select: { id: true },
      });
      // nothing to add, so no branch to lock
      expect(corners.lockLiveCorner).not.toHaveBeenCalled();
      expect(timeline).toEqual([
        'lock member',
        'end assignment',
        'commit',
        'emit',
      ]);
    });

    it('writes one BRANCH_REMOVED row: (role, the branch) → (same role, no branch)', async () => {
      await service.remove(owner, 'staff-1', 'corner-a');

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          profileId: 'staff-1',
          reason: MembershipChangeReason.BRANCH_REMOVED,
          fromRoleId: 4,
          toRoleId: 4,
          fromCornerId: 'corner-a',
          toCornerId: null,
          changedByProfileId: 'owner-1',
        },
      ]);
    });

    it('their last branch may go: the role is never written', async () => {
      const lastBranchGone = {
        id: 'staff-1',
        role: { code: 'STAFF', name: 'Staff' },
        branches: [],
      };
      profiles.viewOf.mockResolvedValue(lastBranchGone);

      await expect(
        service.remove(owner, 'staff-1', 'corner-a'),
      ).resolves.toEqual(lastBranchGone);
      // the only profile write is the lock, which touches no role or status
      expect(tx.profile.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.profile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { updatedAt: ANY_DATE } }),
      );
    });

    it('emits member.moved (REMOVED) after the commit', async () => {
      await service.remove(owner, 'staff-1', 'corner-a');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_MOVED,
        {
          memberProfileId: 'staff-1',
          changedByProfileId: 'owner-1',
          cornerId: 'corner-a',
          change: 'REMOVED',
        },
      );
    });

    it('tidies up a suspended member too: the lock matches the status we read', async () => {
      profiles.findMember.mockResolvedValue(
        member({ status: ProfileStatus.SUSPENDED }),
      );

      await service.remove(owner, 'staff-1', 'corner-a');

      expect(tx.profile.updateMany).toHaveBeenCalledWith({
        // the member's row, written only if they're still who we read
        where: {
          id: 'staff-1',
          companyId: 'company-1',
          roleId: 4,
          status: ProfileStatus.SUSPENDED,
          deletedAt: null,
        },
        data: { updatedAt: ANY_DATE },
      });
    });

    it('404 when they do not work there (or someone removed them a moment ago): nothing recorded or sent', async () => {
      tx.profileBranch.updateManyAndReturn.mockResolvedValue([]);

      await expect(
        service.remove(owner, 'staff-1', 'corner-b'),
      ).rejects.toThrow(new NotFoundException('Not in this branch'));
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('409 when the member changed after we read them: no assignment ended', async () => {
      tx.profile.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.remove(owner, 'staff-1', 'corner-a'),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(tx.profileBranch.updateManyAndReturn).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('404 when they are not a member the caller can see', async () => {
      profiles.findMember.mockResolvedValue(null);

      await expect(
        service.remove(owner, 'staff-1', 'corner-a'),
      ).rejects.toThrow(new NotFoundException('Member not found'));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['a MANAGER', manager],
      ['a STAFF member', staffCaller],
    ])('403 for %s caller', async (_label, caller) => {
      await expect(
        service.remove(caller, 'staff-1', 'corner-a'),
      ).rejects.toThrow(ForbiddenException);
      expect(profiles.findMember).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
