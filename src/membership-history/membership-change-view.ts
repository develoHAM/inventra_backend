import type { Prisma } from '../generated/prisma/client';
import type { MembershipChangeReason } from '../generated/prisma/enums';

/**
 * What a history read selects: the change, plus only the id and name of the
 * people and branches in it (never a phone or an email). Relations are read
 * with no deletedAt filter, so a closed branch or a deleted person keeps
 * their name on old entries.
 */
export const MEMBERSHIP_CHANGE_SELECT = {
  id: true,
  reason: true,
  createdAt: true,
  profile: { select: { id: true, name: true } },
  changedByProfile: { select: { id: true, name: true } },
  fromRole: { select: { code: true, name: true } },
  toRole: { select: { code: true, name: true } },
  fromCompanyStore: { select: { id: true, name: true } },
  toCompanyStore: { select: { id: true, name: true } },
} satisfies Prisma.MembershipChangeSelect;

export type MembershipChangeRow = Prisma.MembershipChangeGetPayload<{
  select: typeof MEMBERSHIP_CHANGE_SELECT;
}>;

/** One history entry as the API returns it. */
export interface MembershipChangeView {
  id: string;
  reason: MembershipChangeReason;
  createdAt: Date;
  member: { id: string; name: string };
  changedBy: { id: string; name: string } | null; // null = made by the system
  fromRole: { code: string; name: string } | null;
  toRole: { code: string; name: string } | null;
  fromBranch: { id: string; name: string } | null;
  toBranch: { id: string; name: string } | null;
}

/** One page of history, newest first. */
export interface MembershipHistoryPage {
  items: MembershipChangeView[];
  // The last item's id: the app sends it back as ?cursor= for the next page.
  // null = this is the last page.
  nextCursor: string | null;
}

/** The database's names → the API's words: user → member, companyStore → branch. */
export function toMembershipChangeView(
  row: MembershipChangeRow,
): MembershipChangeView {
  return {
    id: row.id,
    reason: row.reason,
    createdAt: row.createdAt,
    member: row.profile,
    changedBy: row.changedByProfile,
    fromRole: row.fromRole,
    toRole: row.toRole,
    fromBranch: row.fromCompanyStore,
    toBranch: row.toCompanyStore,
  };
}
