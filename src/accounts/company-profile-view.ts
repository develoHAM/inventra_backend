import type { Prisma } from '../generated/prisma/client';

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
