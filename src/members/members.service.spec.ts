import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MembersService } from './members.service';
import { OwnershipService } from '../authorization/ownership.service';
import type { AuthUser } from '../auth/types/auth-user';
import { MembershipChangeReason, UserStatus } from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

describe('MembersService', () => {
  let service: MembersService;
  let tx: { user: { updateMany: jest.Mock } };
  let prisma: {
    user: { findFirst: jest.Mock; findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let corners: { lockLiveCorner: jest.Mock };
  let history: { record: jest.Mock };
  let storage: { presignGetUrl: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  /** The order things happened in, to prove events fire after commit. */
  let timeline: string[];

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    companyStoreId: null,
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
  };
  const admin: AuthUser = {
    id: 'admin-1',
    companyId: null,
    companyStoreId: null,
    roleId: 1,
    roleCode: 'ADMIN',
    status: UserStatus.ACTIVE,
  };
  const manager: AuthUser = {
    id: 'manager-1',
    companyId: 'company-1',
    companyStoreId: 'corner-a',
    roleId: 3,
    roleCode: 'MANAGER',
    status: UserStatus.ACTIVE,
  };
  const staffCaller: AuthUser = {
    id: 'staff-9',
    companyId: 'company-1',
    companyStoreId: 'corner-a',
    roleId: 4,
    roleCode: 'STAFF',
    status: UserStatus.ACTIVE,
  };

  /** A member row as MembersService selects it. */
  const memberRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'staff-1',
    name: 'Kim Staff',
    profileImageUrl: null,
    phone: '01012345678',
    contactEmail: 'staff@example.com',
    status: UserStatus.ACTIVE,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    companyId: 'company-1',
    companyStoreId: 'corner-a',
    roleId: 4,
    role: { code: 'STAFF', name: 'Staff' },
    companyStore: { id: 'corner-a', name: 'Branch A' },
    ...overrides,
  });

  beforeEach(() => {
    timeline = [];
    tx = {
      user: {
        updateMany: jest.fn().mockImplementation(() => {
          timeline.push('write');
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(memberRow()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(
          memberRow({
            companyStoreId: 'corner-b',
            companyStore: { id: 'corner-b', name: 'Branch B' },
          }),
        ),
      },
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) => {
        const result = await callback(tx);
        timeline.push('commit');
        return result;
      }),
    };
    corners = { lockLiveCorner: jest.fn().mockResolvedValue(true) };
    history = { record: jest.fn().mockResolvedValue(undefined) };
    storage = { presignGetUrl: jest.fn() };
    eventEmitter = {
      emit: jest.fn(() => {
        timeline.push('emit');
        return true;
      }),
    };
    // constructor order: (prisma, ownership, corners, history, storage, eventEmitter)
    service = new MembersService(
      prisma as any,
      new OwnershipService(),
      corners as any,
      history,
      storage as any,
      eventEmitter as any,
    );
  });

  describe('changeBranch', () => {
    it('moves an active member to a live branch of their company', async () => {
      const view = await service.changeBranch(owner, 'staff-1', {
        cornerId: 'corner-b',
      });

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'staff-1', companyId: 'company-1', deletedAt: null },
        }),
      );
      expect(corners.lockLiveCorner).toHaveBeenCalledWith(
        tx,
        'corner-b',
        'company-1',
      );
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'staff-1',
          companyId: 'company-1',
          roleId: 4,
          companyStoreId: 'corner-a',
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        data: { companyStoreId: 'corner-b' },
      });
      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          userId: 'staff-1',
          reason: MembershipChangeReason.MOVED,
          fromRoleId: 4,
          toRoleId: 4,
          fromCornerId: 'corner-a',
          toCornerId: 'corner-b',
          changedByUserId: 'owner-1',
        },
      ]);
      expect(view).toEqual({
        id: 'staff-1',
        name: 'Kim Staff',
        profileImageUrl: null,
        phone: '01012345678',
        contactEmail: 'staff@example.com',
        status: UserStatus.ACTIVE,
        role: { code: 'STAFF', name: 'Staff' },
        branch: { id: 'corner-b', name: 'Branch B' },
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      });
    });

    it('emits member.moved only after the transaction commits', async () => {
      await service.changeBranch(owner, 'staff-1', { cornerId: 'corner-b' });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_MOVED,
        {
          memberUserId: 'staff-1',
          changedByUserId: 'owner-1',
          fromCornerId: 'corner-a',
          toCornerId: 'corner-b',
          reason: 'MOVED',
        },
      );
      expect(timeline).toEqual(['write', 'commit', 'emit']);
    });

    it('cornerId null takes the member off their branch without locking a corner', async () => {
      await service.changeBranch(owner, 'staff-1', { cornerId: null });

      expect(corners.lockLiveCorner).not.toHaveBeenCalled();
      expect(tx.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { companyStoreId: null } }),
      );
      expect(history.record.mock.calls[0][1][0]).toMatchObject({
        fromCornerId: 'corner-a',
        toCornerId: null,
      });
    });

    it('lets the admin move a member of any company', async () => {
      await service.changeBranch(admin, 'staff-1', { cornerId: 'corner-b' });

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'staff-1', deletedAt: null },
        }),
      );
      expect(corners.lockLiveCorner).toHaveBeenCalledWith(
        tx,
        'corner-b',
        'company-1',
      );
    });

    it('moving a member to the branch they are in changes nothing', async () => {
      const view = await service.changeBranch(owner, 'staff-1', {
        cornerId: 'corner-a',
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(view.branch).toEqual({ id: 'corner-a', name: 'Branch A' });
    });

    it('formats a stored avatar key as a presigned URL', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        memberRow({ profileImageUrl: 'users/staff-1/a.png' }),
      );
      storage.presignGetUrl.mockResolvedValue('https://signed/a.png');

      const view = await service.changeBranch(owner, 'staff-1', {
        cornerId: 'corner-b',
      });

      expect(storage.presignGetUrl).toHaveBeenCalledWith('users/staff-1/a.png');
      expect(view.profileImageUrl).toBe('https://signed/a.png');
    });

    describe('refusals (nothing written, nothing emitted)', () => {
      const expectNothingChanged = () => {
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(history.record).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      };

      it('404 when the member is not in the caller company', async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
          service.changeBranch(owner, 'staff-1', { cornerId: 'corner-b' }),
        ).rejects.toThrow(new NotFoundException('Member not found'));
        expectNothingChanged();
      });

      it('404 when the admin targets someone outside any company (e.g. the platform admin)', async () => {
        prisma.user.findFirst.mockResolvedValue(
          memberRow({
            id: 'admin-2',
            companyId: null,
            companyStoreId: null,
            roleId: 1,
            role: { code: 'ADMIN', name: 'Platform Admin' },
            companyStore: null,
          }),
        );

        await expect(
          service.changeBranch(admin, 'admin-2', { cornerId: 'corner-b' }),
        ).rejects.toThrow(new NotFoundException('Member not found'));
        expectNothingChanged();
      });

      it('404 for a member who has no role yet (pending approval)', async () => {
        prisma.user.findFirst.mockResolvedValue(
          memberRow({
            status: UserStatus.PENDING_APPROVAL,
            roleId: null,
            role: null,
          }),
        );

        await expect(
          service.changeBranch(owner, 'staff-1', { cornerId: 'corner-b' }),
        ).rejects.toThrow(NotFoundException);
        expectNothingChanged();
      });

      it('400 for an owner target: owners have no branch', async () => {
        prisma.user.findFirst.mockResolvedValue(
          memberRow({
            id: 'owner-2',
            companyStoreId: null,
            roleId: 2,
            role: { code: 'OWNER', name: 'Company Owner' },
            companyStore: null,
          }),
        );

        await expect(
          service.changeBranch(owner, 'owner-2', { cornerId: 'corner-b' }),
        ).rejects.toThrow(
          new BadRequestException('Only managers and staff belong to a branch'),
        );
        expectNothingChanged();
      });

      it('400 for a member who is not active', async () => {
        prisma.user.findFirst.mockResolvedValue(
          memberRow({ status: UserStatus.SUSPENDED }),
        );

        await expect(
          service.changeBranch(owner, 'staff-1', { cornerId: 'corner-b' }),
        ).rejects.toThrow(
          new BadRequestException('Only active members can be changed'),
        );
        expectNothingChanged();
      });

      it.each([
        ['MANAGER', manager],
        ['STAFF', staffCaller],
      ])('403 for a %s caller', async (_roleCode, caller) => {
        await expect(
          service.changeBranch(caller, 'staff-1', { cornerId: 'corner-b' }),
        ).rejects.toThrow(ForbiddenException);
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expectNothingChanged();
      });
    });

    it('404 when the branch is not a live corner of the member company; nothing written', async () => {
      corners.lockLiveCorner.mockResolvedValue(false);

      await expect(
        service.changeBranch(owner, 'staff-1', { cornerId: 'corner-x' }),
      ).rejects.toThrow(new NotFoundException('Branch not found'));
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('409 when the member changed between the read and the write', async () => {
      tx.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.changeBranch(owner, 'staff-1', { cornerId: 'corner-b' }),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
