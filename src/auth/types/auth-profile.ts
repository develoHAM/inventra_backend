import { ProfileStatus } from '../../generated/prisma/enums';

/** The open company profile a request acts as (`id` = the profile, a `profiles` row). */
export type AuthProfile = {
  id: string;
  accountId: string; // the sign-in this profile belongs to
  companyId: string | null;
  companyStoreId?: string | null;
  roleId: number | null;
  roleCode: string | null;
  status: ProfileStatus;
};
