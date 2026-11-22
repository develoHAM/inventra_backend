import type { MembershipChangeReason } from '../generated/prisma/enums';

/** One history row as MembershipHistoryService.page selects it. */
export interface MembershipChangeRow {
  id: string;
  reason: MembershipChangeReason;
  createdAt: Date;
  profile: { id: string; name: string };
  changedByProfile: { id: string; name: string } | null;
  fromRole: { code: string; name: string } | null;
  toRole: { code: string; name: string } | null;
  fromCompanyStore: { id: string; name: string } | null;
  toCompanyStore: { id: string; name: string } | null;
}

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
