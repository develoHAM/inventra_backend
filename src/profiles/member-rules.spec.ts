import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { decideRoleChange } from './member-rules';
import type { MemberRoleCode } from './member-rules';

/** One request, as the rules see it. Defaults: an owner, a staff target in A. */
const ask = (overrides: {
  callerRole?: string | null;
  callerBranchId?: string | null;
  targetRole?: MemberRoleCode;
  targetBranchId?: string | null;
  requestedRole?: MemberRoleCode;
  cornerIdSent?: boolean;
}) =>
  decideRoleChange({
    callerRole: 'OWNER',
    callerBranchId: null,
    targetRole: 'STAFF',
    targetBranchId: 'branch-a',
    requestedRole: 'MANAGER',
    cornerIdSent: false,
    ...overrides,
  });

describe('decideRoleChange', () => {
  describe('the admin and owners', () => {
    it.each(['ADMIN', 'OWNER'])(
      '%s: manager → owner clears the branch (owners have none)',
      (callerRole) => {
        expect(
          ask({
            callerRole: callerRole,
            targetRole: 'MANAGER',
            requestedRole: 'OWNER',
          }),
        ).toEqual({ branch: 'clear', checkOwnerCount: false });
      },
    );

    it.each(['ADMIN', 'OWNER'])(
      '%s: staff → owner clears the branch',
      (callerRole) => {
        expect(
          ask({
            callerRole: callerRole,
            targetRole: 'STAFF',
            requestedRole: 'OWNER',
          }),
        ).toEqual({ branch: 'clear', checkOwnerCount: false });
      },
    );

    it.each([
      ['ADMIN', 'STAFF', 'MANAGER'],
      ['ADMIN', 'MANAGER', 'STAFF'],
      ['OWNER', 'STAFF', 'MANAGER'],
      ['OWNER', 'MANAGER', 'STAFF'],
    ] as const)(
      '%s: %s → %s keeps the branch',
      (callerRole, targetRole, requestedRole) => {
        expect(
          ask({
            callerRole: callerRole,
            targetRole: targetRole,
            requestedRole: requestedRole,
          }),
        ).toEqual({ branch: 'keep', checkOwnerCount: false });
      },
    );
  });

  describe('demoting an owner', () => {
    it.each(['MANAGER', 'STAFF'] as const)(
      'the admin may demote an owner to %s: the branch is set, and the owner count is checked',
      (requestedRole) => {
        expect(
          ask({
            callerRole: 'ADMIN',
            targetRole: 'OWNER',
            targetBranchId: null,
            requestedRole: requestedRole,
            cornerIdSent: true,
          }),
        ).toEqual({ branch: 'set', checkOwnerCount: true });
      },
    );

    it('the admin must say where the demoted owner goes (400 without cornerId)', () => {
      expect(() =>
        ask({
          callerRole: 'ADMIN',
          targetRole: 'OWNER',
          targetBranchId: null,
          requestedRole: 'STAFF',
          cornerIdSent: false,
        }),
      ).toThrow(BadRequestException);
    });

    it('an owner cannot demote another owner, or themselves (403)', () => {
      expect(() =>
        ask({
          callerRole: 'OWNER',
          targetRole: 'OWNER',
          targetBranchId: null,
          requestedRole: 'MANAGER',
        }),
      ).toThrow(ForbiddenException);
    });

    it('a manager cannot touch an owner (403)', () => {
      expect(() =>
        ask({
          callerRole: 'MANAGER',
          callerBranchId: 'branch-a',
          targetRole: 'OWNER',
          targetBranchId: null,
          requestedRole: 'STAFF',
        }),
      ).toThrow(ForbiddenException);
    });
  });

  describe('a manager', () => {
    it('may promote staff in their own branch to manager; they stay there', () => {
      expect(
        ask({
          callerRole: 'MANAGER',
          callerBranchId: 'branch-a',
          targetRole: 'STAFF',
          targetBranchId: 'branch-a',
          requestedRole: 'MANAGER',
        }),
      ).toEqual({ branch: 'keep', checkOwnerCount: false });
    });

    it('cannot promote staff of another branch (403)', () => {
      expect(() =>
        ask({
          callerRole: 'MANAGER',
          callerBranchId: 'branch-a',
          targetRole: 'STAFF',
          targetBranchId: 'branch-b',
          requestedRole: 'MANAGER',
        }),
      ).toThrow(ForbiddenException);
    });

    it('with no branch cannot promote staff who have no branch either (null is not "the same branch")', () => {
      expect(() =>
        ask({
          callerRole: 'MANAGER',
          callerBranchId: null,
          targetRole: 'STAFF',
          targetBranchId: null,
          requestedRole: 'MANAGER',
        }),
      ).toThrow(ForbiddenException);
    });

    it('cannot demote a manager, even in their own branch (403)', () => {
      expect(() =>
        ask({
          callerRole: 'MANAGER',
          callerBranchId: 'branch-a',
          targetRole: 'MANAGER',
          targetBranchId: 'branch-a',
          requestedRole: 'STAFF',
        }),
      ).toThrow(ForbiddenException);
    });

    it('cannot promote anyone to owner (403)', () => {
      expect(() =>
        ask({
          callerRole: 'MANAGER',
          callerBranchId: 'branch-a',
          targetRole: 'STAFF',
          targetBranchId: 'branch-a',
          requestedRole: 'OWNER',
        }),
      ).toThrow(ForbiddenException);
    });
  });

  it.each(['STAFF', null])('a %s caller cannot change roles (403)', (role) => {
    expect(() =>
      ask({
        callerRole: role,
        callerBranchId: 'branch-a',
        targetRole: 'STAFF',
        targetBranchId: 'branch-a',
        requestedRole: 'MANAGER',
      }),
    ).toThrow(ForbiddenException);
  });

  describe('cornerId', () => {
    it.each([
      ['an owner promoting staff', 'OWNER', 'STAFF', 'MANAGER'],
      ['the admin promoting staff', 'ADMIN', 'STAFF', 'MANAGER'],
      ['the admin promoting a manager to owner', 'ADMIN', 'MANAGER', 'OWNER'],
    ] as const)(
      'is refused for %s (400): moves go through PUT …/branch',
      (_label, callerRole, targetRole, requestedRole) => {
        expect(() =>
          ask({
            callerRole: callerRole,
            targetRole: targetRole,
            requestedRole: requestedRole,
            cornerIdSent: true,
          }),
        ).toThrow(BadRequestException);
      },
    );

    it('is refused even when the "change" would be a no-op (checked first)', () => {
      expect(() =>
        ask({
          callerRole: 'ADMIN',
          targetRole: 'OWNER',
          targetBranchId: null,
          requestedRole: 'OWNER',
          cornerIdSent: true,
        }),
      ).toThrow(BadRequestException);
    });
  });

  it.each([
    ['OWNER', 'STAFF'],
    ['OWNER', 'MANAGER'],
    ['ADMIN', 'OWNER'],
  ] as const)(
    '%s asking for the role a %s already has is a no-op',
    (callerRole, role) => {
      expect(
        ask({
          callerRole: callerRole,
          targetRole: role,
          targetBranchId: role === 'OWNER' ? null : 'branch-a',
          requestedRole: role,
        }),
      ).toBe('noop');
    },
  );
});
