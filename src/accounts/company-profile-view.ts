import type { Prisma } from '../generated/prisma/client';
import type { ProfileStatus } from '../generated/prisma/enums';

/** What sign-in needs to know about the profile it opens. */
export const OPEN_PROFILE_SELECT = {
  id: true,
  status: true,
  companyId: true,
  roleId: true,
} satisfies Prisma.ProfileSelect;

/** The company profile a session has open, as auth responses show it. */
export type OpenProfileSummary = Prisma.ProfileGetPayload<{
  select: typeof OPEN_PROFILE_SELECT;
}>;

/** What one entry of the company dropdown needs. */
export const COMPANY_PROFILE_SELECT = {
  id: true,
  status: true,
  name: true,
  profileImageUrl: true,
  role: { select: { code: true, name: true } },
  company: { select: { id: true, name: true } },
} satisfies Prisma.ProfileSelect;

export type CompanyProfileRow = Prisma.ProfileGetPayload<{
  select: typeof COMPANY_PROFILE_SELECT;
}>;

/** One company the account can open: who they are there, and as what. */
export interface CompanyProfileView {
  profileId: string; // what POST /auth/switch takes
  status: ProfileStatus;
  name: string; // their name in that company
  profileImageUrl: string | null; // a short-lived presigned URL
  role: { code: string; name: string } | null; // null while a join request waits
  company: { id: string; name: string } | null; // null for the platform admin
}
