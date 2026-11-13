import { ProfileStatus } from '../generated/prisma/enums';

/**
 * Profile statuses permitted to authenticate (obtain or keep a session).
 * Excludes soft-deleted users and terminal statuses (REJECTED/SUSPENDED/DEACTIVATED).
 * Shared by JwtAuthGuard (per request) and AuthService.login (at sign-in).
 */
export const CAN_AUTHENTICATE: readonly ProfileStatus[] = [
  ProfileStatus.PENDING_APPROVAL,
  ProfileStatus.ACTIVE,
];
