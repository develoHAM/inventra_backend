import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { OwnershipService } from '../authorization/ownership.service';
import type { AuthProfile } from '../auth/types/auth-profile';
import {
  MembershipChangeReason,
  ProfileStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

/** "Some Date": the moment a row was stamped isn't what these tests check. */
const ANY_DATE: unknown = expect.any(Date);

describe('ProfilesService', () => {
  let service: ProfilesService;
  let tx: {
    profile: { updateMany: jest.Mock; count: jest.Mock };
    company: { updateMany: jest.Mock };
    profileBranch: {
      createManyAndReturn: jest.Mock;
      updateManyAndReturn: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let prisma: {
    profile: {
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
    accountId: 'account-of-manager-1',
    companyId: 'company-1',
    roleId: 3,
    roleCode: 'MANAGER',
    branchIds: ['corner-a'],
    status: ProfileStatus.ACTIVE,
  };
  const staffCaller: AuthProfile = {
    id: 'staff-9',
    accountId: 'account-of-staff-9',
    companyId: 'company-1',
    roleId: 4,
    roleCode: 'STAFF',
    branchIds: ['corner-a'],
    status: ProfileStatus.ACTIVE,
  };

  /** The live branches of a member row (the `branches` each member query selects). */
  const BRANCH_A = { companyStore: { id: 'corner-a', name: 'Branch A' } };
  const BRANCH_B = { companyStore: { id: 'corner-b', name: 'Branch B' } };

  /** A member row as ProfilesService selects it: staff-1, working in Branch A. */
  const memberRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'staff-1',
    name: 'Kim Staff',
    profileImageUrl: null,
    // the phone belongs to the person's sign-in, shared by all their companies
    account: { phone: '01012345678' },
    contactEmail: 'staff@example.com',
    status: ProfileStatus.ACTIVE,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    companyId: 'company-1',
    roleId: 4,
    role: { code: 'STAFF', name: 'Staff' },
    branches: [BRANCH_A],
    ...overrides,
  });

  beforeEach(() => {
    timeline = [];
    tx = {
      profile: {
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
      profileBranch: {
        createManyAndReturn: jest.fn().mockImplementation(() => {
          timeline.push('assign');
          return Promise.resolve([{ id: 'assignment-1' }]);
        }),
        // by default staff-1 works in Branch A
        updateManyAndReturn: jest.fn().mockImplementation(() => {
          timeline.push('end assignments');
          return Promise.resolve([{ companyStoreId: 'corner-a' }]);
        }),
        findMany: jest.fn().mockImplementation(() => {
          timeline.push('read assignments');
          return Promise.resolve([{ companyStoreId: 'corner-a' }]);
        }),
      },
    };
    prisma = {
      profile: {
        findFirst: jest.fn().mockResolvedValue(memberRow()),
        findMany: jest.fn().mockResolvedValue([memberRow()]),
        findUniqueOrThrow: jest.fn().mockResolvedValue(memberRow()),
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
        .mockResolvedValue(new Set(['profiles.read', 'profiles.approve'])),
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
    service = new ProfilesService(
      prisma as any,
      new OwnershipService(),
      permissions as any,
      corners as any,
      history as any,
      storage as any,
      eventEmitter as any,
    );
  });

  describe('findMember', () => {
    it("finds a member of the caller's company, with their role code", async () => {
      const member = await service.findMember(owner, 'staff-1');

      expect(prisma.profile.findFirst).toHaveBeenCalledWith({
        where: { id: 'staff-1', companyId: 'company-1', deletedAt: null },
        select: {
          id: true,
          name: true,
          profileImageUrl: true,
          account: { select: { phone: true } },
          contactEmail: true,
          status: true,
          createdAt: true,
          companyId: true,
          roleId: true,
          role: { select: { code: true, name: true } },
          branches: {
            where: { deletedAt: null, companyStore: { deletedAt: null } },
            select: { companyStore: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      expect(member).toMatchObject({
        id: 'staff-1',
        companyId: 'company-1',
        roleCode: 'STAFF',
      });
    });

    it('does not company-scope the lookup for the admin', async () => {
      await service.findMember(admin, 'staff-1');

      expect(prisma.profile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'staff-1', deletedAt: null } }),
      );
    });

    it.each([
      ['nobody in the caller company', null],
      [
        'someone outside any company (e.g. the platform admin)',
        memberRow({
          id: 'admin-2',
          companyId: null,
          roleId: 1,
          role: { code: 'ADMIN', name: 'Platform Admin' },
          branches: [],
        }),
      ],
      [
        'someone with no role yet (pending approval)',
        memberRow({
          status: ProfileStatus.PENDING_APPROVAL,
          roleId: null,
          role: null,
          branches: [],
        }),
      ],
    ])('is null for %s: the caller decides the 404', async (_label, row) => {
      prisma.profile.findFirst.mockResolvedValue(row);

      await expect(service.findMember(admin, 'someone')).resolves.toBeNull();
    });
  });

  describe('viewOf', () => {
    it('reads the member fresh and shows every live branch, oldest assignment first', async () => {
      prisma.profile.findUniqueOrThrow.mockResolvedValue(
        memberRow({ branches: [BRANCH_A, BRANCH_B] }),
      );

      const view = await service.viewOf('staff-1');

      expect(prisma.profile.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'staff-1' },
        select: {
          id: true,
          name: true,
          profileImageUrl: true,
          account: { select: { phone: true } },
          contactEmail: true,
          status: true,
          createdAt: true,
          companyId: true,
          roleId: true,
          role: { select: { code: true, name: true } },
          branches: {
            where: { deletedAt: null, companyStore: { deletedAt: null } },
            select: { companyStore: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      expect(view).toEqual({
        id: 'staff-1',
        name: 'Kim Staff',
        profileImageUrl: null,
        phone: '01012345678',
        contactEmail: 'staff@example.com',
        status: ProfileStatus.ACTIVE,
        role: { code: 'STAFF', name: 'Staff' },
        branches: [
          { id: 'corner-a', name: 'Branch A' },
          { id: 'corner-b', name: 'Branch B' },
        ],
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      });
    });

    it('shows someone with no branch as an empty list', async () => {
      prisma.profile.findUniqueOrThrow.mockResolvedValue(
        memberRow({ branches: [] }),
      );

      await expect(service.viewOf('staff-1')).resolves.toMatchObject({
        branches: [],
      });
    });

    it('formats a stored avatar key as a presigned URL', async () => {
      prisma.profile.findUniqueOrThrow.mockResolvedValue(
        memberRow({ profileImageUrl: 'profiles/staff-1/a.png' }),
      );
      storage.presignGetUrl.mockResolvedValue('https://signed/a.png');

      const view = await service.viewOf('staff-1');

      expect(storage.presignGetUrl).toHaveBeenCalledWith(
        'profiles/staff-1/a.png',
      );
      expect(view.profileImageUrl).toBe('https://signed/a.png');
    });
  });

  describe('approve', () => {
    const STAFF_ROLE = { id: 4, code: 'STAFF' };
    const MANAGER_ROLE = { id: 3, code: 'MANAGER' };
    const OWNER_ROLE = { id: 2, code: 'OWNER' };
    const pendingRow = () =>
      memberRow({
        id: 'member-1',
        status: ProfileStatus.PENDING_APPROVAL,
        roleId: null,
        role: null,
        branches: [],
      });
    const approvedRow = () =>
      memberRow({
        id: 'member-1',
        status: ProfileStatus.ACTIVE,
        roleId: 4,
        role: { code: 'STAFF', name: 'Staff' },
        branches: [BRANCH_A],
      });

    beforeEach(() => {
      prisma.profile.findFirst.mockResolvedValue(pendingRow());
      prisma.profile.findUniqueOrThrow.mockResolvedValue(approvedRow());
      prisma.role.findUnique.mockResolvedValue(STAFF_ROLE);
    });

    it('gives a pending member of the caller company a role in one guarded write, then their first branch', async () => {
      const view = await service.approve(owner, 'member-1', {
        roleId: 4,
        cornerId: 'corner-a',
      });

      // the lookup is scoped to the caller's company (tenant isolation)
      expect(prisma.profile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'member-1', companyId: 'company-1', deletedAt: null },
        }),
      );
      expect(corners.lockLiveCorner).toHaveBeenCalledWith(
        tx,
        'corner-a',
        'company-1',
      );
      expect(tx.profile.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'member-1',
          status: ProfileStatus.PENDING_APPROVAL,
          roleId: null, // still a newcomer, never a company owner
          deletedAt: null,
        },
        data: { roleId: 4, status: ProfileStatus.ACTIVE },
      });
      // the first assignment: a second live one would be skipped, not thrown
      expect(tx.profileBranch.createManyAndReturn).toHaveBeenCalledWith({
        data: [{ profileId: 'member-1', companyStoreId: 'corner-a' }],
        skipDuplicates: true,
        select: { id: true },
      });
      expect(view).toMatchObject({
        id: 'member-1',
        status: ProfileStatus.ACTIVE,
        role: { code: 'STAFF', name: 'Staff' },
        branches: [{ id: 'corner-a', name: 'Branch A' }],
      });
    });

    it("refuses a company's pending owner (400): approving them as a member would leave the company with no owner", async () => {
      // Company signup stores the owner as pending WITH the OWNER role; they
      // become active through company approval, not member approval.
      prisma.profile.findFirst.mockResolvedValue(
        memberRow({
          id: 'owner-9',
          status: ProfileStatus.PENDING_APPROVAL,
          roleId: 2,
          role: { code: 'OWNER', name: 'Owner' },
          branches: [],
        }),
      );

      await expect(
        service.approve(admin, 'owner-9', { roleId: 4, cornerId: null }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('refuses anyone who is not an owner or a manager, even holding profiles.approve (403)', async () => {
      // e.g. staff given a personal GRANT of profiles.approve: the caller's role
      // decides the rules, not only the permission
      prisma.role.findUnique.mockResolvedValue(MANAGER_ROLE);

      await expect(
        service.approve(staffCaller, 'member-1', {
          roleId: 3,
          cornerId: 'corner-b',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('writes the first history row: no role, no branch → the chosen ones', async () => {
      await service.approve(owner, 'member-1', {
        roleId: 4,
        cornerId: 'corner-a',
      });

      expect(history.record).toHaveBeenCalledWith(tx, [
        {
          companyId: 'company-1',
          profileId: 'member-1',
          reason: MembershipChangeReason.APPROVED,
          fromRoleId: null,
          toRoleId: 4,
          fromCornerId: null,
          toCornerId: 'corner-a',
          changedByProfileId: 'owner-1',
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
        { memberProfileId: 'member-1', approvedByProfileId: 'owner-1' },
      );
      expect(timeline).toEqual(['write', 'assign', 'commit', 'emit']);
    });

    it('cornerId null approves with "no branch yet": no corner locked, no assignment', async () => {
      await service.approve(owner, 'member-1', { roleId: 4, cornerId: null });

      expect(corners.lockLiveCorner).not.toHaveBeenCalled();
      expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
      expect(tx.profile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { roleId: 4, status: ProfileStatus.ACTIVE },
        }),
      );
      expect(history.record.mock.calls[0][1][0]).toMatchObject({
        toCornerId: null,
      });
    });

    it('lets the owner approve as a manager', async () => {
      prisma.role.findUnique.mockResolvedValue(MANAGER_ROLE);

      await service.approve(owner, 'member-1', { roleId: 3, cornerId: null });

      expect(tx.profile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roleId: 3 }),
        }),
      );
    });

    it.each([
      ['an owner', owner],
      ['the admin', admin],
    ])(
      '%s approves a newcomer as an owner: the OWNER role, no branch, one guarded write',
      async (_label, caller) => {
        prisma.role.findUnique.mockResolvedValue(OWNER_ROLE);

        await service.approve(caller, 'member-1', {
          roleId: 2,
          cornerId: null,
        });

        // owners work across the whole company: no branch to lock or join
        expect(corners.lockLiveCorner).not.toHaveBeenCalled();
        expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
        expect(tx.profile.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'member-1',
            status: ProfileStatus.PENDING_APPROVAL,
            roleId: null, // still a newcomer, never a company's pending owner
            deletedAt: null,
          },
          data: { roleId: 2, status: ProfileStatus.ACTIVE },
        });
        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'member-1',
            reason: MembershipChangeReason.APPROVED,
            fromRoleId: null,
            toRoleId: 2,
            fromCornerId: null,
            toCornerId: null,
            changedByProfileId: caller.id,
          },
        ]);
        expect(timeline).toEqual(['write', 'commit', 'emit']);
      },
    );

    it('does not company-scope the lookup for the admin', async () => {
      prisma.profile.findFirst.mockResolvedValue({
        ...pendingRow(),
        companyId: 'company-9',
      });

      await service.approve(admin, 'member-1', {
        roleId: 4,
        cornerId: 'corner-a',
      });

      expect(prisma.profile.findFirst).toHaveBeenCalledWith(
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
      it('may approve as staff into a branch they work in', async () => {
        await service.approve(manager, 'member-1', {
          roleId: 4,
          cornerId: 'corner-a',
        });

        expect(tx.profile.updateMany).toHaveBeenCalled();
      });

      it.each(['corner-a', 'corner-b'])(
        'a manager in two branches may approve into either: %s (Review Focus 1)',
        async (cornerId) => {
          const managerOfTwoBranches = {
            ...manager,
            branchIds: ['corner-a', 'corner-b'],
          };

          await service.approve(managerOfTwoBranches, 'member-1', {
            roleId: 4,
            cornerId: cornerId,
          });

          expect(tx.profileBranch.createManyAndReturn).toHaveBeenCalledWith(
            expect.objectContaining({
              data: [{ profileId: 'member-1', companyStoreId: cornerId }],
            }),
          );
        },
      );

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

      it('403 when approving as an owner (only owners and the admin make owners)', async () => {
        prisma.role.findUnique.mockResolvedValue(OWNER_ROLE);

        await expect(
          service.approve(manager, 'member-1', { roleId: 2, cornerId: null }),
        ).rejects.toThrow(
          new ForbiddenException('Managers can approve only as staff'),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('gets the 400, not the 403, for an owner with a branch: the shape is checked first', async () => {
        prisma.role.findUnique.mockResolvedValue(OWNER_ROLE);

        await expect(
          service.approve(manager, 'member-1', {
            roleId: 2,
            cornerId: 'corner-a',
          }),
        ).rejects.toThrow(
          new BadRequestException('Owners work across the whole company'),
        );
      });

      it.each([
        ['a branch they do not work in', 'corner-c'],
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

      it('403 for a manager with no branch, even with cornerId null (null is not one of their branches)', async () => {
        await expect(
          service.approve({ ...manager, branchIds: [] }, 'member-1', {
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
        prisma.profile.findFirst.mockResolvedValue(null);

        await expect(
          service.approve(owner, 'member-x', { roleId: 4, cornerId: null }),
        ).rejects.toThrow(new NotFoundException('Member not found'));
        expectNothingChanged();
      });

      it('400 for a member who is not pending', async () => {
        prisma.profile.findFirst.mockResolvedValue(memberRow());

        await expect(
          service.approve(owner, 'staff-1', { roleId: 4, cornerId: null }),
        ).rejects.toThrow(
          new BadRequestException('Member is not pending approval'),
        );
        expectNothingChanged();
      });

      it.each([
        ['ADMIN', { id: 1, code: 'ADMIN' }],
        ['an unknown role', null],
      ])('400 for %s: no privilege escalation', async (_label, role) => {
        prisma.role.findUnique.mockResolvedValue(role);

        await expect(
          service.approve(owner, 'member-1', { roleId: 1, cornerId: null }),
        ).rejects.toThrow(new BadRequestException('Invalid role for a member'));
        expectNothingChanged();
      });

      it.each([
        ['an owner', owner],
        ['the admin', admin],
      ])(
        '400 when %s approves an owner into a branch: owners work across the whole company',
        async (_label, caller) => {
          prisma.role.findUnique.mockResolvedValue(OWNER_ROLE);

          await expect(
            service.approve(caller, 'member-1', {
              roleId: 2,
              cornerId: 'corner-a',
            }),
          ).rejects.toThrow(
            new BadRequestException('Owners work across the whole company'),
          );
          expectNothingChanged();
        },
      );
    });

    it('404 when the branch is not a live corner of the member company; nothing written', async () => {
      corners.lockLiveCorner.mockResolvedValue(false);

      await expect(
        service.approve(owner, 'member-1', {
          roleId: 4,
          cornerId: 'corner-x',
        }),
      ).rejects.toThrow(new NotFoundException('Branch not found'));
      expect(tx.profile.updateMany).not.toHaveBeenCalled();
      expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('409 when someone else approved the member first: no assignment either', async () => {
      tx.profile.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve(owner, 'member-1', {
          roleId: 4,
          cornerId: 'corner-a',
        }),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
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
        branches: [], // owners work everywhere: no assignments
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

    describe('promoting to owner', () => {
      it('writes the role by code, then ends every assignment in one statement', async () => {
        await service.changeRole(owner, 'staff-1', { role: 'OWNER' });

        expect(prisma.role.findUniqueOrThrow).toHaveBeenCalledWith({
          where: { code: 'OWNER' },
        });
        expect(tx.profile.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'staff-1',
            companyId: 'company-1',
            roleId: 4,
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
          },
          data: { roleId: 2 },
        });
        expect(tx.profileBranch.updateManyAndReturn).toHaveBeenCalledWith({
          where: { profileId: 'staff-1', deletedAt: null },
          data: { deletedAt: ANY_DATE, deletedByProfileId: 'owner-1' },
          select: { companyStoreId: true },
        });
        // promotions can't break "at least one owner": no company lock, no count
        expect(tx.company.updateMany).not.toHaveBeenCalled();
        expect(tx.profile.count).not.toHaveBeenCalled();
        expect(timeline).toEqual([
          'write',
          'end assignments',
          'commit',
          'emit',
        ]);
      });

      it('records one row per ended assignment: STAFF @ A and STAFF @ B → OWNER @ no branch', async () => {
        tx.profileBranch.updateManyAndReturn.mockResolvedValue([
          { companyStoreId: 'corner-a' },
          { companyStoreId: 'corner-b' },
        ]);

        await service.changeRole(owner, 'staff-1', { role: 'OWNER' });

        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'staff-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 4,
            toRoleId: 2,
            fromCornerId: 'corner-a',
            toCornerId: null,
            changedByProfileId: 'owner-1',
          },
          {
            companyId: 'company-1',
            profileId: 'staff-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 4,
            toRoleId: 2,
            fromCornerId: 'corner-b',
            toCornerId: null,
            changedByProfileId: 'owner-1',
          },
        ]);
      });

      it('someone with no branch still gets one row: STAFF @ none → OWNER @ none', async () => {
        tx.profileBranch.updateManyAndReturn.mockResolvedValue([]);

        await service.changeRole(owner, 'staff-1', { role: 'OWNER' });

        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'staff-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 4,
            toRoleId: 2,
            fromCornerId: null,
            toCornerId: null,
            changedByProfileId: 'owner-1',
          },
        ]);
      });
    });

    describe('staff ↔ manager', () => {
      it('keeps every assignment: reads the live ones after the member is locked', async () => {
        await service.changeRole(owner, 'staff-1', { role: 'MANAGER' });

        expect(tx.profile.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'staff-1',
            companyId: 'company-1',
            roleId: 4,
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
          },
          data: { roleId: 3 },
        });
        expect(tx.profileBranch.findMany).toHaveBeenCalledWith({
          where: {
            profileId: 'staff-1',
            deletedAt: null,
            companyStore: { deletedAt: null },
          },
          select: { companyStoreId: true },
          orderBy: { createdAt: 'asc' },
        });
        expect(tx.profileBranch.updateManyAndReturn).not.toHaveBeenCalled();
        expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
        expect(timeline).toEqual([
          'write',
          'read assignments',
          'commit',
          'emit',
        ]);
      });

      it('records one row per live assignment: STAFF @ A → MANAGER @ A, the same for B', async () => {
        tx.profileBranch.findMany.mockResolvedValue([
          { companyStoreId: 'corner-a' },
          { companyStoreId: 'corner-b' },
        ]);

        await service.changeRole(owner, 'staff-1', { role: 'MANAGER' });

        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'staff-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 4,
            toRoleId: 3,
            fromCornerId: 'corner-a',
            toCornerId: 'corner-a',
            changedByProfileId: 'owner-1',
          },
          {
            companyId: 'company-1',
            profileId: 'staff-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 4,
            toRoleId: 3,
            fromCornerId: 'corner-b',
            toCornerId: 'corner-b',
            changedByProfileId: 'owner-1',
          },
        ]);
      });

      it('someone with no branch gets one row with no branch on both sides', async () => {
        tx.profileBranch.findMany.mockResolvedValue([]);

        await service.changeRole(owner, 'staff-1', { role: 'MANAGER' });

        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'staff-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 4,
            toRoleId: 3,
            fromCornerId: null,
            toCornerId: null,
            changedByProfileId: 'owner-1',
          },
        ]);
      });
    });

    describe('a manager stepping down', () => {
      beforeEach(() => {
        prisma.profile.findFirst.mockResolvedValue(
          memberRow({
            id: 'manager-1',
            roleId: 3,
            role: { code: 'MANAGER', name: 'Store Manager' },
          }),
        );
      });

      it('becomes staff where they work, without the owner count', async () => {
        await service.changeRole(manager, 'manager-1', { role: 'STAFF' });

        expect(tx.profile.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'manager-1',
            companyId: 'company-1',
            roleId: 3,
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
          },
          data: { roleId: 4 },
        });
        // owners always cover what managers do: nothing to count or lock
        expect(tx.company.updateMany).not.toHaveBeenCalled();
        expect(tx.profile.count).not.toHaveBeenCalled();
        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'manager-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 3,
            toRoleId: 4,
            fromCornerId: 'corner-a',
            toCornerId: 'corner-a',
            changedByProfileId: 'manager-1',
          },
        ]);
      });
    });

    describe('an owner stepping down', () => {
      const steppingDownOwner = { ...owner, id: 'owner-2' };

      beforeEach(() => {
        prisma.profile.findFirst.mockResolvedValue(ownerRow());
      });

      it('locks the company row, counts owners, then lands in the branch they chose', async () => {
        await service.changeRole(steppingDownOwner, 'owner-2', {
          role: 'MANAGER',
          cornerId: 'corner-a',
        });

        expect(tx.company.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'company-1' } }),
        );
        expect(tx.profile.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'owner-2',
            companyId: 'company-1',
            roleId: 2,
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
          },
          data: { roleId: 3 },
        });
        expect(tx.profileBranch.createManyAndReturn).toHaveBeenCalledWith({
          data: [{ profileId: 'owner-2', companyStoreId: 'corner-a' }],
          skipDuplicates: true,
          select: { id: true },
        });
        expect(history.record).toHaveBeenCalledWith(tx, [
          {
            companyId: 'company-1',
            profileId: 'owner-2',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 2,
            toRoleId: 3,
            fromCornerId: null,
            toCornerId: 'corner-a',
            changedByProfileId: 'owner-2',
          },
        ]);
        expect(timeline).toEqual([
          'lock company',
          'count owners',
          'lock branch',
          'write',
          'assign',
          'commit',
          'emit',
        ]);
      });

      it('with no branch sent, becomes staff with no branch: nothing locked or assigned', async () => {
        await service.changeRole(steppingDownOwner, 'owner-2', {
          role: 'STAFF',
        });

        expect(corners.lockLiveCorner).not.toHaveBeenCalled();
        expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
        expect(history.record).toHaveBeenCalledWith(tx, [
          expect.objectContaining({
            fromRoleId: 2,
            toRoleId: 4,
            fromCornerId: null,
            toCornerId: null,
          }),
        ]);
      });

      it('409 when they are the last active owner; nothing is changed', async () => {
        tx.profile.count.mockResolvedValue(1);

        await expect(
          service.changeRole(steppingDownOwner, 'owner-2', { role: 'STAFF' }),
        ).rejects.toThrow(
          new ConflictException('A company needs at least one owner'),
        );
        expect(tx.profile.updateMany).not.toHaveBeenCalled();
        expect(history.record).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });
    });

    it('emits member.roleChanged only after the transaction commits', async () => {
      await service.changeRole(owner, 'staff-1', { role: 'MANAGER' });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_ROLE_CHANGED,
        {
          memberProfileId: 'staff-1',
          changedByProfileId: 'owner-1',
          toRoleCode: 'MANAGER',
        },
      );
      expect(timeline).toEqual(['write', 'read assignments', 'commit', 'emit']);
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
        prisma.profile.findFirst.mockResolvedValue(ownerRow());
      });

      it('locks the company row, then counts owners, then the branch, then writes and assigns', async () => {
        await service.changeRole(admin, 'owner-2', {
          role: 'STAFF',
          cornerId: 'corner-b',
        });

        expect(tx.company.updateMany).toHaveBeenCalledWith({
          where: { id: 'company-1' },
          data: { updatedAt: expect.any(Date) },
        });
        expect(tx.profile.count).toHaveBeenCalledWith({
          where: {
            companyId: 'company-1',
            role: { code: 'OWNER' },
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
          },
        });
        expect(corners.lockLiveCorner).toHaveBeenCalledWith(
          tx,
          'corner-b',
          'company-1',
        );
        expect(tx.profile.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'owner-2',
            companyId: 'company-1',
            roleId: 2,
            status: ProfileStatus.ACTIVE,
            deletedAt: null,
          },
          data: { roleId: 4 },
        });
        expect(tx.profileBranch.createManyAndReturn).toHaveBeenCalledWith(
          expect.objectContaining({
            data: [{ profileId: 'owner-2', companyStoreId: 'corner-b' }],
          }),
        );
        expect(timeline).toEqual([
          'lock company',
          'count owners',
          'lock branch',
          'write',
          'assign',
          'commit',
          'emit',
        ]);
      });

      it('cornerId null lands them in no branch: nothing locked or assigned', async () => {
        await service.changeRole(admin, 'owner-2', {
          role: 'MANAGER',
          cornerId: null,
        });

        expect(corners.lockLiveCorner).not.toHaveBeenCalled();
        expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
        expect(tx.profile.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { roleId: 3 } }),
        );
      });

      it('409 when they are the last active owner; nobody is changed', async () => {
        tx.profile.count.mockResolvedValue(1);

        await expect(
          service.changeRole(admin, 'owner-2', {
            role: 'STAFF',
            cornerId: null,
          }),
        ).rejects.toThrow(
          new ConflictException('A company needs at least one owner'),
        );
        expect(tx.profile.updateMany).not.toHaveBeenCalled();
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
        expect(tx.profile.updateMany).not.toHaveBeenCalled();
        expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
      });

      it('no cornerId sent lands them in no branch, the same as null', async () => {
        await service.changeRole(admin, 'owner-2', { role: 'STAFF' });

        expect(corners.lockLiveCorner).not.toHaveBeenCalled();
        expect(tx.profileBranch.createManyAndReturn).not.toHaveBeenCalled();
        expect(tx.profile.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { roleId: 4 } }),
        );
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
        prisma.profile.findFirst.mockResolvedValue(ownerRow());

        await expect(
          service.changeRole(owner, 'owner-2', { role: 'MANAGER' }),
        ).rejects.toThrow(
          new ForbiddenException("Owners cannot change an owner's role"),
        );
        expectNothingChanged();
      });

      it.each([
        ['staff of a branch they share', BRANCH_A],
        ['staff of another branch', BRANCH_B],
      ])(
        '403 when a manager promotes %s: only owners make managers',
        async (_label, branch) => {
          prisma.profile.findFirst.mockResolvedValue(
            memberRow({ branches: [branch] }),
          );

          await expect(
            service.changeRole(manager, 'staff-1', { role: 'MANAGER' }),
          ).rejects.toThrow(
            new ForbiddenException('Managers can only step down themselves'),
          );
          expectNothingChanged();
        },
      );

      it('403 when a manager demotes another manager', async () => {
        prisma.profile.findFirst.mockResolvedValue(
          memberRow({
            id: 'manager-2',
            roleId: 3,
            role: { code: 'MANAGER', name: 'Store Manager' },
          }),
        );

        await expect(
          service.changeRole(manager, 'manager-2', { role: 'STAFF' }),
        ).rejects.toThrow(
          new ForbiddenException('Managers can only step down themselves'),
        );
        expectNothingChanged();
      });

      it.each([
        [
          'the platform admin (no company)',
          memberRow({
            id: 'admin-2',
            companyId: null,
            roleId: 1,
            role: { code: 'ADMIN', name: 'Platform Admin' },
            branches: [],
          }),
        ],
        [
          'someone with no role yet (pending approval)',
          memberRow({
            status: ProfileStatus.PENDING_APPROVAL,
            roleId: null,
            role: null,
            branches: [],
          }),
        ],
      ])('404 when the admin targets %s', async (_label, row) => {
        prisma.profile.findFirst.mockResolvedValue(row);

        await expect(
          service.changeRole(admin, 'someone', { role: 'STAFF' }),
        ).rejects.toThrow(new NotFoundException('Member not found'));
        expectNothingChanged();
      });

      it('400 for a member who is not active', async () => {
        prisma.profile.findFirst.mockResolvedValue(
          memberRow({ status: ProfileStatus.SUSPENDED }),
        );

        await expect(
          service.changeRole(owner, 'staff-1', { role: 'MANAGER' }),
        ).rejects.toThrow(
          new BadRequestException('Only active members can be changed'),
        );
        expectNothingChanged();
      });
    });

    it('409 when the member changed between the read and the write: no assignment read or ended', async () => {
      tx.profile.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.changeRole(owner, 'staff-1', { role: 'OWNER' }),
      ).rejects.toThrow(
        new ConflictException('This member was just changed; reload'),
      );
      expect(tx.profileBranch.updateManyAndReturn).not.toHaveBeenCalled();
      expect(tx.profileBranch.findMany).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    /** The where the list query was sent with. */
    const whereSent = () => prisma.profile.findMany.mock.calls[0][0].where;

    it("lists the caller's company, oldest first, as member views", async () => {
      const profiles = await service.list(owner, {});

      expect(prisma.profile.findMany).toHaveBeenCalledWith({
        where: { companyId: 'company-1', deletedAt: null },
        select: {
          id: true,
          name: true,
          profileImageUrl: true,
          account: { select: { phone: true } },
          contactEmail: true,
          status: true,
          createdAt: true,
          companyId: true,
          roleId: true,
          role: { select: { code: true, name: true } },
          branches: {
            where: { deletedAt: null, companyStore: { deletedAt: null } },
            select: { companyStore: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(profiles).toEqual([
        {
          id: 'staff-1',
          name: 'Kim Staff',
          profileImageUrl: null,
          phone: '01012345678',
          contactEmail: 'staff@example.com',
          status: ProfileStatus.ACTIVE,
          role: { code: 'STAFF', name: 'Staff' },
          branches: [{ id: 'corner-a', name: 'Branch A' }],
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
      expect(prisma.profile.findMany).not.toHaveBeenCalled();
    });

    it('filters by branch: people with a live assignment there', async () => {
      await service.list(owner, { cornerId: 'corner-a' });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        branches: {
          some: {
            companyStoreId: 'corner-a',
            deletedAt: null,
            companyStore: { deletedAt: null },
          },
        },
      });
    });

    it('turns cornerId "none" into people with no LIVE assignment (ended ones are history)', async () => {
      await service.list(owner, { cornerId: 'none' });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        branches: {
          none: { deletedAt: null, companyStore: { deletedAt: null } },
        },
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
      await service.list(owner, { status: ProfileStatus.PENDING_APPROVAL });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        status: ProfileStatus.PENDING_APPROVAL,
      });
    });

    it('combines filters, and none of them can replace the company', async () => {
      await service.list(owner, {
        companyId: 'company-9',
        cornerId: 'corner-a',
        role: 'STAFF',
        status: ProfileStatus.ACTIVE,
      });

      expect(whereSent()).toEqual({
        companyId: 'company-1',
        deletedAt: null,
        branches: {
          some: {
            companyStoreId: 'corner-a',
            deletedAt: null,
            companyStore: { deletedAt: null },
          },
        },
        role: { code: 'STAFF' },
        status: ProfileStatus.ACTIVE,
      });
    });

    it('shows a pending member, who has no role and no branch yet', async () => {
      prisma.profile.findMany.mockResolvedValue([
        memberRow({
          status: ProfileStatus.PENDING_APPROVAL,
          roleId: null,
          role: null,
          branches: [],
        }),
      ]);

      const [pending] = await service.list(owner, {});

      expect(pending).toMatchObject({
        status: ProfileStatus.PENDING_APPROVAL,
        role: null,
        branches: [],
      });
    });

    it('shows each branch of someone who works in two', async () => {
      prisma.profile.findMany.mockResolvedValue([
        memberRow({ branches: [BRANCH_A, BRANCH_B] }),
      ]);

      const [member] = await service.list(owner, {});

      expect(member.branches).toEqual([
        { id: 'corner-a', name: 'Branch A' },
        { id: 'corner-b', name: 'Branch B' },
      ]);
    });

    it("turns each member's stored avatar key into a presigned link", async () => {
      prisma.profile.findMany.mockResolvedValue([
        memberRow({ id: 'a', profileImageUrl: 'profiles/a/1.png' }),
        memberRow({ id: 'b', profileImageUrl: null }),
      ]);
      storage.presignGetUrl.mockResolvedValue('https://signed/1.png');

      const profiles = await service.list(owner, {});

      expect(storage.presignGetUrl).toHaveBeenCalledTimes(1);
      expect(storage.presignGetUrl).toHaveBeenCalledWith('profiles/a/1.png');
      expect(profiles.map((member) => member.profileImageUrl)).toEqual([
        'https://signed/1.png',
        null,
      ]);
    });

    describe('people waiting for approval', () => {
      const cannotApprove = () =>
        permissions.getEffectivePermissions.mockResolvedValue(
          new Set(['profiles.read']),
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
          NOT: { status: ProfileStatus.PENDING_APPROVAL },
        });
      });

      it('stay hidden when someone who cannot approve asks for them by status', async () => {
        cannotApprove();

        await service.list(staffCaller, {
          status: ProfileStatus.PENDING_APPROVAL,
        });

        // both conditions apply, so nothing can match
        expect(whereSent()).toEqual({
          companyId: 'company-1',
          deletedAt: null,
          NOT: { status: ProfileStatus.PENDING_APPROVAL },
          status: ProfileStatus.PENDING_APPROVAL,
        });
      });

      it.each([
        ['an owner', owner],
        ['a manager', manager],
      ])('are shown to %s holding profiles.approve', async (_label, caller) => {
        await service.list(caller, {});

        expect(whereSent()).not.toHaveProperty('NOT');
      });

      it('stay hidden from a manager with no branch: they can approve no one', async () => {
        const managerWithoutBranch = { ...manager, branchIds: [] };

        await service.list(managerWithoutBranch, {});

        expect(whereSent()).toHaveProperty('NOT', {
          status: ProfileStatus.PENDING_APPROVAL,
        });
      });

      it('stay hidden from staff granted profiles.approve: their role still cannot approve', async () => {
        // the default mock holds profiles.approve, as a personal GRANT would
        await service.list(staffCaller, {});

        expect(whereSent()).toHaveProperty('NOT', {
          status: ProfileStatus.PENDING_APPROVAL,
        });
      });

      it('are hidden from a manager denied profiles.approve', async () => {
        cannotApprove();

        await service.list(manager, {});

        expect(whereSent()).toHaveProperty('NOT', {
          status: ProfileStatus.PENDING_APPROVAL,
        });
      });
    });

    it('returns an empty list when nobody matches', async () => {
      prisma.profile.findMany.mockResolvedValue([]);

      await expect(service.list(owner, {})).resolves.toEqual([]);
    });
  });

  describe('listHistory', () => {
    const QUERY = { limit: 20 };
    const PAGE = { items: [], nextCursor: null };

    /** The person whose history is asked for: staff-1, working in Branch A by default. */
    const personFound = (overrides: Record<string, unknown> = {}) =>
      prisma.profile.findFirst.mockResolvedValue({
        id: 'staff-1',
        branches: [{ companyStoreId: 'corner-a' }],
        ...overrides,
      });

    beforeEach(() => {
      history.page.mockResolvedValue(PAGE);
    });

    it("looks the person up inside the caller's company, with their live branches", async () => {
      personFound();

      await service.listHistory(owner, 'staff-1', QUERY);

      expect(prisma.profile.findFirst).toHaveBeenCalledWith({
        where: { id: 'staff-1', companyId: 'company-1', deletedAt: null },
        select: {
          id: true,
          branches: {
            where: { deletedAt: null, companyStore: { deletedAt: null } },
            select: { companyStoreId: true },
          },
        },
      });
    });

    it('404s someone outside the company, and reads no history', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);

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
      expect(history.page).toHaveBeenCalledWith(
        { profileId: 'staff-1' },
        QUERY,
      );
    });

    it('the admin reads anyone, in any company', async () => {
      personFound();

      await service.listHistory(admin, 'staff-1', QUERY);

      expect(prisma.profile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'staff-1', deletedAt: null },
        }),
      );
      expect(history.page).toHaveBeenCalledWith(
        { profileId: 'staff-1' },
        QUERY,
      );
    });

    it('anyone reads their own history', async () => {
      personFound({ id: 'staff-9' });

      await service.listHistory(staffCaller, 'staff-9', QUERY);

      expect(history.page).toHaveBeenCalledWith(
        { profileId: 'staff-9' },
        QUERY,
      );
    });

    it('a manager reads the history of someone who works in a branch they work in', async () => {
      personFound(); // Branch A, the manager's branch

      await service.listHistory(manager, 'staff-1', QUERY);

      expect(history.page).toHaveBeenCalledWith(
        { profileId: 'staff-1' },
        QUERY,
      );
    });

    it('one shared branch is enough, among several on each side', async () => {
      personFound({
        branches: [
          { companyStoreId: 'corner-c' },
          { companyStoreId: 'corner-a' },
        ],
      });
      const managerOfTwoBranches = {
        ...manager,
        branchIds: ['corner-b', 'corner-a'],
      };

      await service.listHistory(managerOfTwoBranches, 'staff-1', QUERY);

      expect(history.page).toHaveBeenCalled();
    });

    it.each([
      ['works only in other branches', [{ companyStoreId: 'corner-b' }]],
      ['has no branch', []],
    ])(
      'a manager cannot read someone who %s (403)',
      async (_label, branches) => {
        personFound({ branches: branches });

        await expect(
          service.listHistory(manager, 'staff-1', QUERY),
        ).rejects.toThrow(
          new ForbiddenException("You cannot read this member's history"),
        );
        expect(history.page).not.toHaveBeenCalled();
      },
    );

    it('a manager with no branch manages nobody, not everyone else with no branch (403)', async () => {
      personFound({ branches: [] });
      const managerWithoutBranch = { ...manager, branchIds: [] };

      await expect(
        service.listHistory(managerWithoutBranch, 'staff-1', QUERY),
      ).rejects.toThrow(ForbiddenException);
      expect(history.page).not.toHaveBeenCalled();
    });

    it("staff cannot read a colleague's history, even in a branch they share (403)", async () => {
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
        branches: [],
        status: ProfileStatus.PENDING_APPROVAL,
      });

      await service.listHistory(owner, 'pending-1', QUERY);

      expect(history.page).toHaveBeenCalledWith(
        { profileId: 'pending-1' },
        QUERY,
      );
    });
  });
});
