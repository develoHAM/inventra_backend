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

/**
 * The role-change rulebook: no database, no side effects. Throws 400/403
 * when the change isn't allowed; otherwise says what to do.
 */
export function decideRoleChange(input: {
  callerRole: string | null;
  callerBranchId: string | null;
  targetRole: MemberRoleCode;
  targetBranchId: string | null;
  requestedRole: MemberRoleCode;
  cornerIdSent: boolean;
}): RoleChangeDecision {
  const isAdmin = input.callerRole === 'ADMIN';
  const isOwnerDemotion =
    input.targetRole === 'OWNER' && input.requestedRole !== 'OWNER';

  // Only the admin demoting an owner chooses a branch here; everyone else
  // moves people with PUT /profiles/:id/branch.
  if (input.cornerIdSent && !(isAdmin && isOwnerDemotion))
    throw new BadRequestException(
      'cornerId is only for the admin demoting an owner',
    );
  if (input.requestedRole === input.targetRole) return 'noop';

  if (isAdmin || input.callerRole === 'OWNER') {
    if (input.targetRole === 'OWNER') {
      if (!isAdmin)
        throw new ForbiddenException("Owners cannot change an owner's role");
      if (!input.cornerIdSent)
        throw new BadRequestException(
          'Choose a branch (or null) for the demoted owner',
        );
      return { branch: 'set', checkOwnerCount: true };
    }
    if (input.requestedRole === 'OWNER')
      return { branch: 'clear', checkOwnerCount: false }; // owners have no branch
    return { branch: 'keep', checkOwnerCount: false }; // staff <-> manager
  }

  if (input.callerRole === 'MANAGER') {
    if (input.targetRole === 'OWNER')
      throw new ForbiddenException("Managers cannot change an owner's role");
    // null === null must not count as "the same branch"
    const inOwnBranch =
      input.callerBranchId !== null &&
      input.targetBranchId === input.callerBranchId;
    if (
      input.targetRole === 'STAFF' &&
      input.requestedRole === 'MANAGER' &&
      inOwnBranch
    )
      return { branch: 'keep', checkOwnerCount: false };
    throw new ForbiddenException(
      'Managers can only promote staff of their own branch to manager',
    );
  }

  throw new ForbiddenException('You cannot change member roles');
}
