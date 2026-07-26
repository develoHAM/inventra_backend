import { UserStatus } from '../generated/prisma/enums';

/**
 * User statuses permitted to authenticate (obtain or keep a session).
 * Excludes soft-deleted users and terminal statuses (REJECTED/SUSPENDED/DEACTIVATED).
 * Shared by JwtAuthGuard (per request) and AuthService.login (at sign-in).
 */
export const CAN_AUTHENTICATE: readonly UserStatus[] = [
  UserStatus.PENDING_APPROVAL,
  UserStatus.ACTIVE,
];
