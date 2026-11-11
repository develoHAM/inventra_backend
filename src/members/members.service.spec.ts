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
import { MEMBER_SELECT } from './member-view';

describe('MembersService', () => {
  let service: MembersService;
  let tx: {
    user: { updateMany: jest.Mock; count: jest.Mock };
    company: { updateMany: jest.Mock };
  };
  let prisma: {
    user: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    role: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let permissions: { getEffectivePermissions: jest.Mock };
  let corners: { lockLiveCorner: jest.Mock };
  let history: { record: jest.Mock; page: jest.Mock };
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
        count: jest.fn().mockImplementation(() => {
          timeline.push('count owners');
          return Promise.resolve(2);
        }),
      },
      company: {
        updateMany: jest.fn().mockImplementation(() => {
          timeline.push('lock company');
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(memberRow()),
        findMany: jest.fn().mockResolvedValue([memberRow()]),
        findUniqueOrThrow: jest.fn().mockResolvedValue(
          memberRow({
            companyStoreId: 'corner-b',
            companyStore: { id: 'corner-b', name: 'Branch B' },
          }),
        ),
      },
      role: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) => {
        const result = await callback(tx);
        timeline.push('commit');
        return result;
      }),
    };
    // an approver by default; the list tests narrow this down
    permissions = {
      getEffectivePermissions: jest
        .fn()
        .mockResolvedValue(new Set(['users.read', 'users.approve'])),
    };
    corners = { lockLiveCorner: jest.fn().mockResolvedValue(true) };
    history = {
      record: jest.fn().mockResolvedValue(undefined),
      page: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    storage = { presignGetUrl: jest.fn() };
    eventEmitter = {
      emit: jest.fn(() => {
        timeline.push('emit');
        return true;
      }),
    };
    // constructor order: (prisma, ownership, permissions, corners, history, storage, eventEmitter)
    service = new MembersService(
      prisma as any,
      new OwnershipService(),
      permissions as any,
      corners as any,
      history as any,
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

  describe('changeRole', () => {
    const ROLE_IDS: Record<string, number> = { OWNER: 2, MANAGER: 3, STAFF: 4 };
    const ownerRow = (overrides: Record<string, unknown> = {}) =>
      memberRow({
        id: 'owner-2',
        roleId: 2,
        role: { code: 'OWNER', name: 'Company Owner' },
        companyStoreId: null,
        companyStore: null,
        ...overrides,
      });

    beforeEach(() => {
      prisma.role.findUniqueOrThrow.mockImplementation(
        ({ where }: { where: { code: string } }) =>
          Promise.resolve({ id: ROLE_IDS[where.code], code: where.code }),
      );
      corners.lockLiveCorner.mockImplementation(() => {
        timeline.push('lock branch');
        return Promise.resolve(true);
      });
    });

    it('promotes staff to owner: role by code, branch cleared, one guarded write', async () => {
      await service.changeRole(owner, 'staff-1', { role: 'OWNER' });

      expect(prisma.role.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { code: 'OWNER' },
      });
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'staff-1',
          companyId: 'company-1',
          roleId: 4,
          companyStoreId: 'corner-a',
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        data: { roleId: 2, companyStoreId: null },
      });
      // promotions can't break "at least one owner": no company lock, no count
      expect(tx.company.updateMany).not.toHaveBeenCalled();
      expect(tx.user.count).not.toHaveBeenCalled();
    });

    it('records one snapshot row: STAFF @ A → OWNER @ no branch', async () => {
      await service.changeRole(owner, 'staff-1', { role: 'OWNER' });

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          userId: 'staff-1',
          reason: MembershipChangeReason.ROLE_CHANGED,
          fromRoleId: 4,
          toRoleId: 2,
          fromCornerId: 'corner-a',
          toCornerId: null,
          changedByUserId: 'owner-1',
        },
      ]);
    });

    it('keeps the branch for staff → manager', async () => {
      await service.changeRole(owner, 'staff-1', { role: 'MANAGER' });

      expect(tx.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { roleId: 3, companyStoreId: 'corner-a' },
        }),
      );
    });

    it('lets a manager promote staff of their own branch', async () => {
      await service.changeRole(manager, 'staff-1', { role: 'MANAGER' });

      expect(tx.user.updateMany).toHaveBeenCalled();
      expect(history.record.mock.calls[0][1][0]).toMatchObject({
        changedByUserId: 'manager-1',
      });
    });

    it('emits member.roleChanged only after the transaction commits', async () => {
      await service.changeRole(owner, 'staff-1', { role: 'MANAGER' });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_ROLE_CHANGED,
        {
          memberUserId: 'staff-1',
          changedByUserId: 'owner-1',
          toRoleCode: 'MANAGER',
        },
      );
      expect(timeline).toEqual(['write', 'commit', 'emit']);
    });

    it('a no-op decision writes nothing and returns the member', async () => {
      const view = await service.changeRole(owner, 'staff-1', {
        role: 'STAFF',
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(view.role).toEqual({ code: 'STAFF', name: 'Staff' });
    });

    describe('the admin demoting an owner', () => {
      beforeEach(() => {
        prisma.user.findFirst.mockResolvedValue(ownerRow());
      });

      it('locks the company row, then counts owners, then the branch, then writes', async () => {
        await service.changeRole(admin, 'owner-2', {
          role: 'STAFF',
          cornerId: 'corner-b',
        });

        expect(tx.company.updateMany).toHaveBeenCalledWith({
          where: { id: 'company-1' },
          data: { updatedAt: expect.any(Date) },
        });
        expect(tx.user.count).toHaveBeenCalledWith({
          where: {
            companyId: 'company-1',
            role: { code: 'OWNER' },
            status: UserStatus.ACTIVE,
            deletedAt: null,
          },
        });
        expect(corners.lockLiveCorner).toHaveBeenCalledWith(
          tx,
          'corner-b',
          'company-1',
        );
        expect(tx.user.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { roleId: 4, companyStoreId: 'corner-b' },
          }),
        );
        expect(timeline).toEqual([
          'lock company',
          'count owners',
          'lock branch',
          'write',
          'commit',
          'emit',
        ]);
      });

      it('cornerId null lands them in no branch, without locking a branch', async () => {
        await service.changeRole(admin, 'owner-2', {
          role: 'MANAGER',
          cornerId: null,
        });

        expect(corners.lockLiveCorner).not.toHaveBeenCalled();
        expect(tx.user.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { roleId: 3, companyStoreId: null },
          }),
        );
      });

      it('409 when they are the last active owner; nobody is changed', async () => {
        tx.user.count.mockResolvedValue(1);

        await expect(
          service.changeRole(admin, 'owner-2', {
            role: 'STAFF',
            cornerId: null,
          }),
        ).rejects.toThrow(
          new ConflictException('A company needs at least one owner'),
        );
        expect(tx.user.updateMany).not.toHaveBeenCalled();
        expect(history.record).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('404 when the branch is not a live corner of their company', async () => {
        corners.lockLiveCorner.mockResolvedValue(false);

        await expect(
          service.changeRole(admin, 'owner-2', {
            role: 'STAFF',
            cornerId: 'corner-x',
          }),
        ).rejects.toThrow(new NotFoundException('Branch not found'));
        expect(tx.user.updateMany).not.toHaveBeenCalled();
      });

      it('400 when no cornerId is sent (decided before any write)', async () => {
        await expect(
          service.changeRole(admin, 'owner-2', { role: 'STAFF' }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    it('treats cornerId: null as sent (refused for anything but demoting an owner)', async () => {
      await expect(
        service.changeRole(owner, 'staff-1', {
          role: 'MANAGER',
          cornerId: null,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('refusals (nothing written, nothing emitted)', () => {
      const expectNothingChanged = () => {
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(history.record).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      };

      it('403 when an owner tries to demote another owner', async () => {
        prisma.user.findFirst.mockResolvedValue(ownerRow());

        await expect(
          service.changeRole(owner, 'owner-2', { role: 'MANAGER' }),
        ).rejects.toThrow(ForbiddenException);
        expectNothingChanged();
      });

      it('403 when a manager promotes staff of another branch', async () => {
        prisma.user.findFirst.mockResolvedValue(
          memberRow({
            companyStoreId: 'corner-b',
            companyStore: { id: 'corner-b', name: 'Branch B' },
          }),
        );

        await expect(
          service.changeRole(manager, 'staff-1', { role: 'MANAGER' }),
        ).rejects.toThrow(ForbiddenException);
        expectNothingChanged();
      });

      it('404 when the admin targets the platform admin (no company)', async () => {
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
          service.changeRole(admin, 'admin-2', { role: 'STAFF' }),
        ).rejects.toThrow(new NotFoundException('Member not found'));
        expectNothingChanged();
      });

      it('400 for a member who is not active', async () => {
        prisma.user.findFirst.mockResolvedValue(
          memberRow({ status: UserStatus.SUSPENDED }),
        );

        await expect(
          service.changeRole(owner, 'staff-1', { role: 'MANAGER' }),
        ).rejects.toThrow(
          new BadRequestException('Only active members can be changed'),
        );
        expectNothingChanged();
      });
    });

    it('409 when the member changed between the read and the write', async () => {
      tx.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.changeRole(owner, 'staff-1', { role: 'MANAGER' }),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    /** The where the list query was sent with. */
    const whereSent = () => prisma.user.findMany.mock.calls[0][0].where;

    it("lists the caller's company, oldest first, as member views", async () => {
      const members = await service.list(owner, {});

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { companyId: 'company-1', deletedAt: null },
        select: MEMBER_SELECT,
        orderBy: { createdAt: 'asc' },
      });
      expect(members).toEqual([
        {
          id: 'staff-1',
          name: 'Kim Staff',
          profileImageUrl: null,
          phone: '01012345678',
          contactEmail: 'staff@example.com',
          status: UserStatus.ACTIVE,
          role: { code: 'STAFF', name: 'Staff' },
          branch: { id: 'corner-a', name: 'Branch A' },
          createdAt: new Date('2026-11-01T00:00:00.000Z'),
        },
      ]);
    });

    it.each([
      ['an owner', () => owner],
      ['a manager', () => manager],
      ['staff', () => staffCaller],
    ])(
      '%s cannot list another company by naming it',
      async (_label, caller) => {
        await service.list(caller(), { companyId: 'company-9' });

        expect(whereSent().companyId).toBe('company-1');
      },
    );

    it('lets the admin list the company they name', async () => {
      await service.list(admin, { companyId: 'company-9' });

      expect(whereSent().companyId).toBe('company-9');
    });

    it('400 when the admin does not say which company', async () => {
      await expect(service.list(admin, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('filters by branch', async () => {
      await service.list(owner, { cornerId: 'corner-a' });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        companyStoreId: 'corner-a',
      });
    });

    it('turns cornerId "none" into people with no branch', async () => {
      await service.list(owner, { cornerId: 'none' });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        companyStoreId: null,
      });
    });

    it('filters by role, through the role relation', async () => {
      await service.list(owner, { role: 'MANAGER' });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        role: { code: 'MANAGER' },
      });
    });

    it('filters by status', async () => {
      await service.list(owner, { status: UserStatus.PENDING_APPROVAL });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        status: UserStatus.PENDING_APPROVAL,
      });
    });

    it('combines filters, and none of them can replace the company', async () => {
      await service.list(owner, {
        companyId: 'company-9',
        cornerId: 'corner-a',
        role: 'STAFF',
        status: UserStatus.ACTIVE,
      });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        companyStoreId: 'corner-a',
        role: { code: 'STAFF' },
        status: UserStatus.ACTIVE,
      });
    });

    it('shows a pending member, who has no role and no branch yet', async () => {
      prisma.user.findMany.mockResolvedValue([
        memberRow({
          status: UserStatus.PENDING_APPROVAL,
          roleId: null,
          role: null,
          companyStoreId: null,
          companyStore: null,
        }),
      ]);

      const [pending] = await service.list(owner, {});

      expect(pending).toMatchObject({
        status: UserStatus.PENDING_APPROVAL,
        role: null,
        branch: null,
      });
    });

    it("turns each member's stored avatar key into a presigned link", async () => {
      prisma.user.findMany.mockResolvedValue([
        memberRow({ id: 'a', profileImageUrl: 'users/a/1.png' }),
        memberRow({ id: 'b', profileImageUrl: null }),
      ]);
      storage.presignGetUrl.mockResolvedValue('https://signed/1.png');

      const members = await service.list(owner, {});

      expect(storage.presignGetUrl).toHaveBeenCalledTimes(1);
      expect(storage.presignGetUrl).toHaveBeenCalledWith('users/a/1.png');
      expect(members.map((member) => member.profileImageUrl)).toEqual([
        'https://signed/1.png',
        null,
      ]);
    });

    describe('people waiting for approval', () => {
      const cannotApprove = () =>
        permissions.getEffectivePermissions.mockResolvedValue(
          new Set(['users.read']),
        );

      it("are decided by the caller's real permission", async () => {
        await service.list(staffCaller, {});

        expect(permissions.getEffectivePermissions).toHaveBeenCalledWith(
          staffCaller,
        );
      });

      it('are hidden from someone who cannot approve', async () => {
        cannotApprove();

        await service.list(staffCaller, {});

        expect(whereSent()).toEqual({
          companyId: 'company-1',
          deletedAt: null,
          NOT: { status: UserStatus.PENDING_APPROVAL },
        });
      });

      it('stay hidden when someone who cannot approve asks for them by status', async () => {
        cannotApprove();

        await service.list(staffCaller, {
          status: UserStatus.PENDING_APPROVAL,
        });

        // both conditions apply, so nothing can match
        expect(whereSent()).toEqual({
          companyId: 'company-1',
          deletedAt: null,
          NOT: { status: UserStatus.PENDING_APPROVAL },
          status: UserStatus.PENDING_APPROVAL,
        });
      });

      it('are shown to staff who were granted users.approve', async () => {
        await service.list(staffCaller, {});

        expect(whereSent()).not.toHaveProperty('NOT');
      });

      it('are hidden from a manager denied users.approve', async () => {
        cannotApprove();

        await service.list(manager, {});

        expect(whereSent()).toHaveProperty('NOT', {
          status: UserStatus.PENDING_APPROVAL,
        });
      });
    });

    it('returns an empty list when nobody matches', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await expect(service.list(owner, {})).resolves.toEqual([]);
    });
  });

  describe('listHistory', () => {
    const QUERY = { limit: 20 };
    const PAGE = { items: [], nextCursor: null };

    /** The person whose history is asked for: staff-1, in Branch A by default. */
    const personFound = (overrides: Record<string, unknown> = {}) =>
      prisma.user.findFirst.mockResolvedValue({
        id: 'staff-1',
        companyStoreId: 'corner-a',
        ...overrides,
      });

    beforeEach(() => {
      history.page.mockResolvedValue(PAGE);
    });

    it("looks the person up inside the caller's company", async () => {
      personFound();

      await service.listHistory(owner, 'staff-1', QUERY);

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'staff-1', companyId: 'company-1', deletedAt: null },
        }),
      );
    });

    it('404s someone outside the company, and reads no history', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.listHistory(owner, 'staff-1', QUERY),
      ).rejects.toThrow(NotFoundException);
      expect(history.page).not.toHaveBeenCalled();
    });

    it("an owner reads anyone's history in their company: that person's rows, paged", async () => {
      personFound();

      await expect(service.listHistory(owner, 'staff-1', QUERY)).resolves.toBe(
        PAGE,
      );
      expect(history.page).toHaveBeenCalledWith({ userId: 'staff-1' }, QUERY);
    });

    it('the admin reads anyone, in any company', async () => {
      personFound();

      await service.listHistory(admin, 'staff-1', QUERY);

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'staff-1', deletedAt: null },
        }),
      );
      expect(history.page).toHaveBeenCalledWith({ userId: 'staff-1' }, QUERY);
    });

    it('anyone reads their own history', async () => {
      personFound({ id: 'staff-9' });

      await service.listHistory(staffCaller, 'staff-9', QUERY);

      expect(history.page).toHaveBeenCalledWith({ userId: 'staff-9' }, QUERY);
    });

    it('a manager reads the history of someone in their branch', async () => {
      personFound(); // Branch A, the manager's branch

      await service.listHistory(manager, 'staff-1', QUERY);

      expect(history.page).toHaveBeenCalledWith({ userId: 'staff-1' }, QUERY);
    });

    it('a manager cannot read someone in another branch, or with no branch (403)', async () => {
      personFound({ companyStoreId: 'corner-b' });
      await expect(
        service.listHistory(manager, 'staff-1', QUERY),
      ).rejects.toThrow(ForbiddenException);

      personFound({ companyStoreId: null });
      await expect(
        service.listHistory(manager, 'staff-1', QUERY),
      ).rejects.toThrow(ForbiddenException);

      expect(history.page).not.toHaveBeenCalled();
    });

    it('a manager with no branch manages nobody, not everyone else with no branch (403)', async () => {
      personFound({ companyStoreId: null });
      const managerWithoutBranch: AuthUser = {
        ...manager,
        companyStoreId: null,
      };

      await expect(
        service.listHistory(managerWithoutBranch, 'staff-1', QUERY),
      ).rejects.toThrow(ForbiddenException);
      expect(history.page).not.toHaveBeenCalled();
    });

    it("staff cannot read a colleague's history, even in their own branch (403)", async () => {
      personFound(); // Branch A, the staff caller's branch too

      await expect(
        service.listHistory(staffCaller, 'staff-1', QUERY),
      ).rejects.toThrow(ForbiddenException);
      expect(history.page).not.toHaveBeenCalled();
    });

    it('someone waiting for approval, with no role yet, is still found', async () => {
      // no role, no branch: a lookup that required a member role would 404
      personFound({
        id: 'pending-1',
        companyStoreId: null,
        status: UserStatus.PENDING_APPROVAL,
      });

      await service.listHistory(owner, 'pending-1', QUERY);

      expect(history.page).toHaveBeenCalledWith({ userId: 'pending-1' }, QUERY);
    });
  });
});
