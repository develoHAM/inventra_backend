import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { decideRoleChange } from './member-rules';
import type { MemberRoleCode, RoleChangeDecision } from './member-rules';

/** One request, as the rules see it. Defaults: an owner promoting someone else's staff. */
const ask = (overrides: {
  callerRole?: string | null;
  isSelf?: boolean;
  targetRole?: MemberRoleCode;
  requestedRole?: MemberRoleCode;
  cornerIdSent?: boolean;
}) =>
  decideRoleChange({
    callerRole: 'OWNER',
    isSelf: false,
    targetRole: 'STAFF',
    requestedRole: 'MANAGER',
    cornerIdSent: false,
    ...overrides,
  });

const KEEP: RoleChangeDecision = { branch: 'keep', checkOwnerCount: false };
const CLEAR: RoleChangeDecision = { branch: 'clear', checkOwnerCount: false };
const DEMOTE_OWNER: RoleChangeDecision = {
  branch: 'set',
  checkOwnerCount: true,
};

describe('decideRoleChange', () => {
  // One row per allowed line of "Who may do what" (piece-3 spec):
  // [label, caller, isSelf, target, requested, cornerIdSent, decision]
  // prettier-ignore
  it.each([
    ['the admin promotes staff to manager', 'ADMIN', false, 'STAFF', 'MANAGER', false, KEEP],
    ['the admin demotes a manager to staff', 'ADMIN', false, 'MANAGER', 'STAFF', false, KEEP],
    ['the admin promotes a manager to owner', 'ADMIN', false, 'MANAGER', 'OWNER', false, CLEAR],
    ['the admin promotes staff to owner', 'ADMIN', false, 'STAFF', 'OWNER', false, CLEAR],
    ['the admin demotes an owner into a branch', 'ADMIN', false, 'OWNER', 'MANAGER', true, DEMOTE_OWNER],
    ['the admin demotes an owner, no branch sent', 'ADMIN', false, 'OWNER', 'STAFF', false, DEMOTE_OWNER],
    ['an owner promotes staff to manager', 'OWNER', false, 'STAFF', 'MANAGER', false, KEEP],
    ['an owner demotes a manager to staff', 'OWNER', false, 'MANAGER', 'STAFF', false, KEEP],
    ['an owner promotes staff to owner', 'OWNER', false, 'STAFF', 'OWNER', false, CLEAR],
    ['an owner promotes a manager to owner', 'OWNER', false, 'MANAGER', 'OWNER', false, CLEAR],
    ['an owner steps down to manager, into a branch', 'OWNER', true, 'OWNER', 'MANAGER', true, DEMOTE_OWNER],
    ['an owner steps down to staff, no branch sent', 'OWNER', true, 'OWNER', 'STAFF', false, DEMOTE_OWNER],
    ['a manager steps down to staff', 'MANAGER', true, 'MANAGER', 'STAFF', false, KEEP],
  ] as const)(
    '%s',
    (_label, callerRole, isSelf, targetRole, requestedRole, cornerIdSent, decision) => {
      expect(
        ask({
          callerRole: callerRole,
          isSelf: isSelf,
          targetRole: targetRole,
          requestedRole: requestedRole,
          cornerIdSent: cornerIdSent,
        }),
      ).toEqual(decision);
    },
  );

  // Every refusal, with its exact answer (the class and the message):
  // [label, caller, isSelf, target, requested, cornerIdSent, error]
  // prettier-ignore
  it.each([
    ["an owner can't demote another owner", 'OWNER', false, 'OWNER', 'MANAGER', false,
      new ForbiddenException("Owners cannot change an owner's role")],
    ["a manager can't promote staff, even in their own branch", 'MANAGER', false, 'STAFF', 'MANAGER', false,
      new ForbiddenException('Managers can only step down themselves')],
    ["a manager can't demote another manager", 'MANAGER', false, 'MANAGER', 'STAFF', false,
      new ForbiddenException('Managers can only step down themselves')],
    ["a manager can't touch an owner", 'MANAGER', false, 'OWNER', 'STAFF', false,
      new ForbiddenException('Managers can only step down themselves')],
    ["a manager can't promote staff to owner", 'MANAGER', false, 'STAFF', 'OWNER', false,
      new ForbiddenException('Managers can only step down themselves')],
    ["a manager can't promote themselves to owner", 'MANAGER', true, 'MANAGER', 'OWNER', false,
      new ForbiddenException('Managers can only step down themselves')],
    ["staff can't promote themselves", 'STAFF', true, 'STAFF', 'MANAGER', false,
      new ForbiddenException('You cannot change member roles')],
    ["staff can't promote a colleague", 'STAFF', false, 'STAFF', 'MANAGER', false,
      new ForbiddenException('You cannot change member roles')],
    ["a caller with no role can't change anyone", null, false, 'STAFF', 'MANAGER', false,
      new ForbiddenException('You cannot change member roles')],
    ['a branch with a promotion is malformed', 'OWNER', false, 'STAFF', 'MANAGER', true,
      new BadRequestException('cornerId is only for demoting an owner')],
    ['a branch with a promotion to owner is malformed', 'ADMIN', false, 'MANAGER', 'OWNER', true,
      new BadRequestException('cornerId is only for demoting an owner')],
    ['a branch is malformed even for a no-op (the shape is checked first)', 'ADMIN', false, 'OWNER', 'OWNER', true,
      new BadRequestException('cornerId is only for demoting an owner')],
    ['the shape is checked before who is asking: staff sending a branch gets the 400', 'STAFF', false, 'STAFF', 'MANAGER', true,
      new BadRequestException('cornerId is only for demoting an owner')],
  ] as const)(
    '%s',
    (_label, callerRole, isSelf, targetRole, requestedRole, cornerIdSent, error) => {
      const attempt = () =>
        ask({
          callerRole: callerRole,
          isSelf: isSelf,
          targetRole: targetRole,
          requestedRole: requestedRole,
          cornerIdSent: cornerIdSent,
        });
      // toThrow(anError) compares only the message, so the class is checked too
      expect(attempt).toThrow(error.constructor as new () => Error);
      expect(attempt).toThrow(error);
    },
  );

  it.each([
    ['ADMIN', 'OWNER'],
    ['OWNER', 'STAFF'],
    ['OWNER', 'MANAGER'],
    ['MANAGER', 'STAFF'], // harmless: nothing changes and nothing is revealed
  ] as const)(
    '%s asking for the role a %s already has is a no-op',
    (callerRole, role) => {
      expect(
        ask({ callerRole: callerRole, targetRole: role, requestedRole: role }),
      ).toBe('noop');
    },
  );
});
