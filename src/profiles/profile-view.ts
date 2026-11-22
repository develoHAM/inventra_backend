import type { ProfileStatus } from '../generated/prisma/enums';
import type { MemberRoleCode } from './member-rules';

/**
 * A member as ProfilesService's queries select them: what the screen shows
 * and what the rules need. Each query writes its select out in full;
 * TypeScript checks every result against this shape, so a field left out of
 * a select is a compile error.
 */
export interface ProfileRow {
  id: string;
  name: string;
  profileImageUrl: string | null; // a storage key, presigned by toView
  account: { phone: string | null };
  contactEmail: string | null;
  status: ProfileStatus;
  createdAt: Date;
  companyId: string | null;
  roleId: number | null;
  role: { code: string; name: string } | null;
  branches: { companyStore: { id: string; name: string } }[];
}

/** A member the rules can act on: in a company, with a member role. */
export type MemberRow = ProfileRow & {
  companyId: string;
  roleCode: MemberRoleCode;
};

/** One member as the API returns it. */
export interface ProfileView {
  id: string;
  name: string;
  profileImageUrl: string | null; // a short-lived presigned URL
  phone: string | null;
  contactEmail: string | null;
  status: ProfileStatus;
  role: { code: string; name: string } | null;
  branches: { id: string; name: string }[]; // none for owners, or no branch yet
  createdAt: Date;
}
