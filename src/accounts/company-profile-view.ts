import type { ProfileStatus } from '../generated/prisma/enums';

/**
 * The company profile a session has open, as auth responses show it: what
 * sign-in needs to know about the profile it opens.
 */
export interface OpenProfileSummary {
  id: string;
  status: ProfileStatus;
  companyId: string | null;
  roleId: number | null;
}

/** What one entry of the company dropdown needs, as the queries select it. */
export interface CompanyProfileRow {
  id: string;
  status: ProfileStatus;
  name: string;
  profileImageUrl: string | null; // a storage key, presigned for the view
  role: { code: string; name: string } | null;
  company: { id: string; name: string } | null;
}

/** One company the account can open: who they are there, and as what. */
export interface CompanyProfileView {
  profileId: string; // what POST /auth/switch takes
  status: ProfileStatus;
  name: string; // their name in that company
  profileImageUrl: string | null; // a short-lived presigned URL
  role: { code: string; name: string } | null; // null while a join request waits
  company: { id: string; name: string } | null; // null for the platform admin
}
