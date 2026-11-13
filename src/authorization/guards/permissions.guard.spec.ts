import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import { AuthProfile } from '../../auth/types/auth-profile';
import { ProfileStatus } from '../../generated/prisma/enums';

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let permissionsService: { getEffectivePermissions: jest.Mock };

  const profile: AuthProfile = {
    id: 'profile-1',
    accountId: 'account-of-profile-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: ProfileStatus.ACTIVE,
  };

  // The guard reads request.profile, so the fake request carries whatever profile we pass.
  function contextWith(reqProfile: unknown): ExecutionContext {
    return {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => ({ profile: reqProfile }) }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    permissionsService = { getEffectivePermissions: jest.fn() };
    guard = new PermissionsGuard(reflector as any, permissionsService as any);
  });

  it('allows a route with no @RequirePermissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(contextWith(profile))).resolves.toBe(true);
    expect(permissionsService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('allows when the required list is empty', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);

    await expect(guard.canActivate(contextWith(profile))).resolves.toBe(true);
    expect(permissionsService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('allows when the user has all required permissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(['profiles.approve']);
    permissionsService.getEffectivePermissions.mockResolvedValue(
      new Set(['profiles.approve', 'products.read']),
    );

    await expect(guard.canActivate(contextWith(profile))).resolves.toBe(true);
  });

  it('denies (403) when the user is missing any required permission', async () => {
    // requires TWO permissions; the user has only one → must be rejected
    reflector.getAllAndOverride.mockReturnValue([
      'profiles.approve',
      'companies.update',
    ]);
    permissionsService.getEffectivePermissions.mockResolvedValue(
      new Set(['profiles.approve']),
    );

    await expect(guard.canActivate(contextWith(profile))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('denies (403) a PENDING (non-ACTIVE) user on a permissioned route', async () => {
    reflector.getAllAndOverride.mockReturnValue(['profiles.approve']);
    const pendingProfile = {
      ...profile,
      status: ProfileStatus.PENDING_APPROVAL,
    };

    await expect(
      guard.canActivate(contextWith(pendingProfile)),
    ).rejects.toThrow(ForbiddenException);
    // status is rejected before any permission lookup happens
    expect(permissionsService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('denies (403) when no authenticated user is present', async () => {
    reflector.getAllAndOverride.mockReturnValue(['profiles.approve']);

    await expect(guard.canActivate(contextWith(undefined))).rejects.toThrow(
      ForbiddenException,
    );
    expect(permissionsService.getEffectivePermissions).not.toHaveBeenCalled();
  });
});
