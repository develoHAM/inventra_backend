import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import { AuthUser } from '../../auth/types/auth-user';
import { UserStatus } from '../../generated/prisma/enums';

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let permissionsService: { getEffectivePermissions: jest.Mock };

  const user: AuthUser = {
    id: 'user-1',
    companyId: 'company-1',
    roleId: 2,
    status: UserStatus.ACTIVE,
  };

  // The guard reads req.user, so the fake request carries whatever user we pass.
  function contextWith(reqUser: unknown): ExecutionContext {
    return {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => ({ user: reqUser }) }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    permissionsService = { getEffectivePermissions: jest.fn() };
    guard = new PermissionsGuard(reflector as any, permissionsService as any);
  });

  it('allows a route with no @RequirePermissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(contextWith(user))).resolves.toBe(true);
    expect(permissionsService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('allows when the required list is empty', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);

    await expect(guard.canActivate(contextWith(user))).resolves.toBe(true);
    expect(permissionsService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('allows when the user has all required permissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users.approve']);
    permissionsService.getEffectivePermissions.mockResolvedValue(
      new Set(['users.approve', 'products.read']),
    );

    await expect(guard.canActivate(contextWith(user))).resolves.toBe(true);
  });

  it('denies (403) when the user is missing any required permission', async () => {
    // requires TWO permissions; the user has only one → must be rejected
    reflector.getAllAndOverride.mockReturnValue([
      'users.approve',
      'companies.update',
    ]);
    permissionsService.getEffectivePermissions.mockResolvedValue(
      new Set(['users.approve']),
    );

    await expect(guard.canActivate(contextWith(user))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('denies (403) a PENDING (non-ACTIVE) user on a permissioned route', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users.approve']);
    const pendingUser = { ...user, status: UserStatus.PENDING_APPROVAL };

    await expect(
      guard.canActivate(contextWith(pendingUser)),
    ).rejects.toThrow(ForbiddenException);
    // status is rejected before any permission lookup happens
    expect(permissionsService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('denies (403) when no authenticated user is present', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users.approve']);

    await expect(guard.canActivate(contextWith(undefined))).rejects.toThrow(
      ForbiddenException,
    );
    expect(permissionsService.getEffectivePermissions).not.toHaveBeenCalled();
  });
});
