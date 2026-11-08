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
    role: { findUnique: jest.Mock };
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
      role: { findUnique: jest.fn() },
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

  describe('approve', () => {
    const STAFF_ROLE = { id: 4, code: 'STAFF' };
    const MANAGER_ROLE = { id: 3, code: 'MANAGER' };
    const pendingRow = () =>
      memberRow({
        id: 'member-1',
        status: UserStatus.PENDING_APPROVAL,
        roleId: null,
        role: null,
        companyStoreId: null,
        companyStore: null,
      });
    const approvedRow = () =>
      memberRow({
        id: 'member-1',
        status: UserStatus.ACTIVE,
        roleId: 4,
        role: { code: 'STAFF', name: 'Staff' },
        companyStoreId: 'corner-a',
        companyStore: { id: 'corner-a', name: 'Branch A' },
      });

    beforeEach(() => {
      prisma.user.findFirst.mockResolvedValue(pendingRow());
      prisma.user.findUniqueOrThrow.mockResolvedValue(approvedRow());
      prisma.role.findUnique.mockResolvedValue(STAFF_ROLE);
    });

    it('gives a pending member of the caller company a role and a branch, in one guarded write', async () => {
      const view = await service.approve(owner, 'member-1', {
        roleId: 4,
        cornerId: 'corner-a',
      });

      // the lookup is scoped to the caller's company (tenant isolation)
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'member-1', companyId: 'company-1', deletedAt: null },
        }),
      );
      expect(corners.lockLiveCorner).toHaveBeenCalledWith(
        tx,
        'corner-a',
        'company-1',
      );
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'member-1',
          status: UserStatus.PENDING_APPROVAL,
          deletedAt: null,
        },
        data: {
          roleId: 4,
          status: UserStatus.ACTIVE,
          companyStoreId: 'corner-a',
        },
      });
      expect(view).toMatchObject({
        id: 'member-1',
        status: UserStatus.ACTIVE,
        role: { code: 'STAFF', name: 'Staff' },
        branch: { id: 'corner-a', name: 'Branch A' },
      });
    });

    it('writes the first history row: no role, no branch → the chosen ones', async () => {
      await service.approve(owner, 'member-1', {
        roleId: 4,
        cornerId: 'corner-a',
      });

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          userId: 'member-1',
          reason: MembershipChangeReason.APPROVED,
          fromRoleId: null,
          toRoleId: 4,
          fromCornerId: null,
          toCornerId: 'corner-a',
          changedByUserId: 'owner-1',
        },
      ]);
    });

    it('emits member.approved only after the transaction commits', async () => {
      await service.approve(owner, 'member-1', {
        roleId: 4,
        cornerId: 'corner-a',
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_APPROVED,
        { memberUserId: 'member-1', approvedByUserId: 'owner-1' },
      );
      expect(timeline).toEqual(['write', 'commit', 'emit']);
    });

    it('cornerId null approves with "no branch yet", without locking a corner', async () => {
      await service.approve(owner, 'member-1', { roleId: 4, cornerId: null });

      expect(corners.lockLiveCorner).not.toHaveBeenCalled();
      expect(tx.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ companyStoreId: null }),
        }),
      );
      expect(history.record.mock.calls[0][1][0]).toMatchObject({
        toCornerId: null,
      });
    });

    it('lets the owner approve as a manager', async () => {
      prisma.role.findUnique.mockResolvedValue(MANAGER_ROLE);

      await service.approve(owner, 'member-1', { roleId: 3, cornerId: null });

      expect(tx.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roleId: 3 }),
        }),
      );
    });

    it('does not company-scope the lookup for the admin', async () => {
      prisma.user.findFirst.mockResolvedValue({
        ...pendingRow(),
        companyId: 'company-9',
      });

      await service.approve(admin, 'member-1', {
        roleId: 4,
        cornerId: 'corner-a',
      });

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'member-1', deletedAt: null },
        }),
      );
      // the branch must belong to the member's company
      expect(corners.lockLiveCorner).toHaveBeenCalledWith(
        tx,
        'corner-a',
        'company-9',
      );
    });

    describe('a manager approver', () => {
      it('may approve as staff into their own branch', async () => {
        await service.approve(manager, 'member-1', {
          roleId: 4,
          cornerId: 'corner-a',
        });

        expect(tx.user.updateMany).toHaveBeenCalled();
      });

      it('403 when approving as a manager', async () => {
        prisma.role.findUnique.mockResolvedValue(MANAGER_ROLE);

        await expect(
          service.approve(manager, 'member-1', {
            roleId: 3,
            cornerId: 'corner-a',
          }),
        ).rejects.toThrow(
          new ForbiddenException('Managers can approve only as staff'),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it.each([
        ['another branch', 'corner-b'],
        ['no branch', null],
      ])('403 when approving into %s', async (_label, cornerId) => {
        await expect(
          service.approve(manager, 'member-1', {
            roleId: 4,
            cornerId: cornerId,
          }),
        ).rejects.toThrow(
          new ForbiddenException(
            'Managers can approve only into their own branch',
          ),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('403 for a manager with no branch, even with cornerId null (null is not "their branch")', async () => {
        await expect(
          service.approve({ ...manager, companyStoreId: null }, 'member-1', {
            roleId: 4,
            cornerId: null,
          }),
        ).rejects.toThrow(ForbiddenException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('refusals (nothing written, nothing emitted)', () => {
      const expectNothingChanged = () => {
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(history.record).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      };

      it('404 for a member in another company (no cross-tenant leak)', async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
          service.approve(owner, 'member-x', { roleId: 4, cornerId: null }),
        ).rejects.toThrow(new NotFoundException('Member not found'));
        expectNothingChanged();
      });

      it('400 for a member who is not pending', async () => {
        prisma.user.findFirst.mockResolvedValue(memberRow());

        await expect(
          service.approve(owner, 'staff-1', { roleId: 4, cornerId: null }),
        ).rejects.toThrow(
          new BadRequestException('Member is not pending approval'),
        );
        expectNothingChanged();
      });

      it.each([
        ['OWNER', { id: 2, code: 'OWNER' }],
        ['ADMIN', { id: 1, code: 'ADMIN' }],
        ['an unknown role', null],
      ])('400 for %s: no privilege escalation', async (_label, role) => {
        prisma.role.findUnique.mockResolvedValue(role);

        await expect(
          service.approve(owner, 'member-1', { roleId: 2, cornerId: null }),
        ).rejects.toThrow(new BadRequestException('Invalid role for a member'));
        expectNothingChanged();
      });
    });

    it('404 when the branch is not a live corner of the member company; nothing written', async () => {
      corners.lockLiveCorner.mockResolvedValue(false);

      await expect(
        service.approve(owner, 'member-1', {
          roleId: 4,
          cornerId: 'corner-x',
        }),
      ).rejects.toThrow(new NotFoundException('Branch not found'));
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('409 when someone else approved the member first', async () => {
      tx.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve(owner, 'member-1', {
          roleId: 4,
          cornerId: 'corner-a',
        }),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
