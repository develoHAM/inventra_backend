import { ProfileStatus } from '../../generated/prisma/enums';

/** The open company profile a request acts as (`id` = the profile, a `profiles` row). */
export type AuthProfile = {
  id: string;
  accountId: string; // the sign-in this profile belongs to
  companyId: string | null;
  roleId: number | null;
  roleCode: string | null;
  // The branches they work in now (live assignments in live branches),
  // oldest first. Owners and the admin have none: they work everywhere.
  branchIds: string[];
  status: ProfileStatus;
};
