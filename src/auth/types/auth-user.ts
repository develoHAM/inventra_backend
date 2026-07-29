import { UserStatus } from '../../generated/prisma/enums';

export type AuthUser = {
  id: string;
  companyId: string | null;
  roleId: number | null;
  roleCode: string | null;
  status: UserStatus;
};
