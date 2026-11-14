import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ACCOUNT_ROUTE_KEY } from './decorators/account-route.decorator';
import { ProfileStatus } from '../generated/prisma/enums';
import type { AuthAccount } from './types/auth-account';
import type { AuthProfile } from './types/auth-profile';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: {
    me: jest.Mock;
    logout: jest.Mock;
    switchProfile: jest.Mock;
  };

  const account: AuthAccount = {
    accountId: 'account-1',
    profileId: 'profile-1',
  };
  const profile: AuthProfile = {
    id: 'profile-1',
    accountId: 'account-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: ProfileStatus.ACTIVE,
  };
  const metadata = (key: string, method: keyof AuthController) =>
    Reflect.getMetadata(key, AuthController.prototype[method]);

  beforeEach(() => {
    authService = {
      me: jest.fn().mockResolvedValue({}),
      logout: jest.fn().mockResolvedValue(undefined),
      switchProfile: jest.fn().mockResolvedValue({}),
    };
    controller = new AuthController(authService as any);
  });

  it.each(['register', 'registerMember', 'login', 'refresh'] as const)(
    '%s is public (no token yet)',
    (method) => {
      expect(metadata(IS_PUBLIC_KEY, method)).toBe(true);
    },
  );

  it.each(['me', 'logout', 'switchProfile'] as const)(
    '%s is an @AccountRoute(): works with no company open, still needs a sign-in',
    (method) => {
      expect(metadata(ACCOUNT_ROUTE_KEY, method)).toBe(true);
      expect(metadata(IS_PUBLIC_KEY, method)).toBeUndefined();
    },
  );

  it('switchProfile is POST /auth/switch', () => {
    expect(metadata(METHOD_METADATA, 'switchProfile')).toBe(RequestMethod.POST);
    expect(metadata(PATH_METADATA, 'switchProfile')).toBe('switch');
  });

  it('me passes the account and the open profile', async () => {
    await controller.me(account, profile);

    expect(authService.me).toHaveBeenCalledWith(account, profile);
  });

  it('me with no profile open passes null (request.profile is undefined)', async () => {
    const profileLess: AuthAccount = {
      accountId: 'account-1',
      profileId: null,
    };

    await controller.me(profileLess, undefined);

    expect(authService.me).toHaveBeenCalledWith(profileLess, null);
  });

  it("logout revokes on the caller's account", async () => {
    const dto = { refreshToken: 'refresh-token' };

    await controller.logout(account, dto);

    expect(authService.logout).toHaveBeenCalledWith('account-1', dto);
  });

  it('switchProfile passes the account from the JWT and the body', async () => {
    const dto = { refreshToken: 'refresh-token', profileId: 'profile-2' };

    await controller.switchProfile(account, dto);

    expect(authService.switchProfile).toHaveBeenCalledWith(account, dto);
  });
});
