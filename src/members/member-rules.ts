/** The roles a company member can have (the platform ADMIN is not one). */
export const MEMBER_ROLES = ['OWNER', 'MANAGER', 'STAFF'] as const;
export type MemberRoleCode = (typeof MEMBER_ROLES)[number];

export function isMemberRole(code: string): code is MemberRoleCode {
  return (MEMBER_ROLES as readonly string[]).includes(code);
}
