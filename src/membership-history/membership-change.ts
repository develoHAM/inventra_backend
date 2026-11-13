import type { MembershipChangeReason } from '../generated/prisma/enums';

/**
 * One history row as callers describe it: the person's role and branch
 * before and after the change. Always fill both sides, even when a side
 * didn't change, so every row is a full snapshot.
 */
export interface MembershipChangeInput {
  companyId: string;
  profileId: string;
  reason: MembershipChangeReason;
  fromRoleId: number | null;
  toRoleId: number | null;
  fromCornerId: string | null; // null = no branch
  toCornerId: string | null;
  changedByProfileId: string | null; // null = made by the system
}
