import { BadRequestException, ForbiddenException } from '@nestjs/common';

/** The roles a company member can have (the platform ADMIN is not one). */
export const MEMBER_ROLES = ['OWNER', 'MANAGER', 'STAFF'] as const;
export type MemberRoleCode = (typeof MEMBER_ROLES)[number];

export function isMemberRole(code: string): code is MemberRoleCode {
  return (MEMBER_ROLES as readonly string[]).includes(code);
}

/**
 * What a role change does to the person's branch, and whether the
 * "a company keeps at least one owner" check applies.
 */
export type RoleChangeDecision =
  'noop' | { branch: 'keep' | 'clear' | 'set'; checkOwnerCount: boolean };

/** Staff ↔ manager: they stay where they work, and no owner is lost. */
const KEEP_BRANCH: RoleChangeDecision = {
  branch: 'keep',
  checkOwnerCount: false,
};
/** To owner: owners have no branch, and the company gains an owner. */
const CLEAR_BRANCH: RoleChangeDecision = {
  branch: 'clear',
  checkOwnerCount: false,
};
/** An owner demoted: they land in the branch sent (or none), and the company loses an owner. */
const DEMOTE_OWNER: RoleChangeDecision = {
  branch: 'set',
  checkOwnerCount: true,
};

/**
 * The role-change rulebook ("Who may do what" in the piece-3 spec): no
 * database, no side effects. Throws 400/403 when the change isn't allowed;
 * otherwise says what to do. The checks run top to bottom and the first
 * match wins, so their order is part of the rules.
 */
export function decideRoleChange(input: {
  callerRole: string | null;
  isSelf: boolean; // the caller is changing their own role
  targetRole: MemberRoleCode;
  requestedRole: MemberRoleCode;
  cornerIdSent: boolean;
}): RoleChangeDecision {
  const isOwnerDemotion =
    input.targetRole === 'OWNER' && input.requestedRole !== 'OWNER';

  // 1. The shape of the request: a branch only makes sense for an owner
  //    being demoted (it's where they land). Checked before who is asking,
  //    so a malformed request gets the same 400 from anyone.
  if (input.cornerIdSent && !isOwnerDemotion)
    throw new BadRequestException('cornerId is only for demoting an owner');

  // 2. Nothing to change.
  if (input.requestedRole === input.targetRole) return 'noop';

  // 3. The platform admin: every change. Demoting an owner still counts owners.
  if (input.callerRole === 'ADMIN') {
    if (isOwnerDemotion) return DEMOTE_OWNER;
    if (input.requestedRole === 'OWNER') return CLEAR_BRANCH;
    return KEEP_BRANCH;
  }

  // 4. An owner: every change except to another owner. Stepping down
  //    themselves goes through the same owner count as the admin's demotion.
  if (input.callerRole === 'OWNER') {
    if (input.targetRole === 'OWNER') {
      if (!input.isSelf)
        throw new ForbiddenException("Owners cannot change an owner's role");
      return DEMOTE_OWNER;
    }
    if (input.requestedRole === 'OWNER') return CLEAR_BRANCH;
    return KEEP_BRANCH;
  }

  // 5. A manager: only stepping down. Only owners make managers, because a
  //    manager's powers reach the company-wide catalog.
  if (input.callerRole === 'MANAGER') {
    const isSteppingDown =
      input.isSelf &&
      input.targetRole === 'MANAGER' &&
      input.requestedRole === 'STAFF';
    if (isSteppingDown) return KEEP_BRANCH;
    throw new ForbiddenException('Managers can only step down themselves');
  }

  // 6. Staff, or anyone else.
  throw new ForbiddenException('You cannot change member roles');
}
