import type { Prisma } from '../generated/prisma/client';
import type { ProfileStatus } from '../generated/prisma/enums';

/** The columns every member read selects: what the screen shows + what the rules need. */
export const PROFILE_SELECT = {
  id: true,
  name: true,
  profileImageUrl: true,
  account: { select: { phone: true } }, // the sign-in's phone, shared by all their companies
  contactEmail: true,
  status: true,
  createdAt: true,
  companyId: true,
  companyStoreId: true,
  roleId: true,
  role: { select: { code: true, name: true } },
  companyStore: { select: { id: true, name: true } },
} satisfies Prisma.ProfileSelect;

export type ProfileRow = Prisma.ProfileGetPayload<{
  select: typeof PROFILE_SELECT;
}>;

/** One member as the API returns it. */
export interface ProfileView {
  id: string;
  name: string;
  profileImageUrl: string | null; // a short-lived presigned URL
  phone: string | null;
  contactEmail: string | null;
  status: ProfileStatus;
  role: { code: string; name: string } | null;
  branch: { id: string; name: string } | null;
  createdAt: Date;
}
