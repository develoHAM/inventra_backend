import type { Prisma } from '../generated/prisma/client';
import type { UserStatus } from '../generated/prisma/enums';

/** The columns every member read selects: what the screen shows + what the rules need. */
export const MEMBER_SELECT = {
  id: true,
  name: true,
  profileImageUrl: true,
  phone: true,
  contactEmail: true,
  status: true,
  createdAt: true,
  companyId: true,
  companyStoreId: true,
  roleId: true,
  role: { select: { code: true, name: true } },
  companyStore: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

export type MemberRow = Prisma.UserGetPayload<{ select: typeof MEMBER_SELECT }>;

/** One member as the API returns it. */
export interface MemberView {
  id: string;
  name: string;
  profileImageUrl: string | null; // a short-lived presigned URL
  phone: string | null;
  contactEmail: string | null;
  status: UserStatus;
  role: { code: string; name: string } | null;
  branch: { id: string; name: string } | null;
  createdAt: Date;
}
