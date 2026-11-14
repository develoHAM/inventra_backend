import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { DevicesController } from './devices.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../authorization/decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ACCOUNT_ROUTE_KEY } from '../auth/decorators/account-route.decorator';
import type { AuthAccount } from '../auth/types/auth-account';
import { DevicePlatform } from '../generated/prisma/enums';

describe('DevicesController', () => {
  let controller: DevicesController;
  let devices: { register: jest.Mock; unregister: jest.Mock };

  // a device belongs to the sign-in: it works with no company open, so a
  // brand-new account still gets the "you've been approved" push
  const caller: AuthAccount = { accountId: 'account-1', profileId: null };

  const metadata = (key: string, method: keyof DevicesController) =>
    Reflect.getMetadata(key, DevicesController.prototype[method]);

  beforeEach(() => {
    devices = {
      register: jest.fn().mockResolvedValue(undefined),
      unregister: jest.fn().mockResolvedValue(undefined),
    };
    controller = new DevicesController(devices as any);
  });

  it.each(['register', 'unregister'] as const)(
    '%s is self-service: logged in, but no permission and not public',
    (method) => {
      expect(metadata(REQUIRE_PERMISSIONS_KEY, method)).toBeUndefined();
      expect(metadata(IS_PUBLIC_KEY, method)).toBeUndefined();
    },
  );

  it('the whole controller is an @AccountRoute(): no company needs to be open', () => {
    expect(Reflect.getMetadata(ACCOUNT_ROUTE_KEY, DevicesController)).toBe(
      true,
    );
  });

  it.each(['register', 'unregister'] as const)('%s answers 204', (method) => {
    expect(metadata(HTTP_CODE_METADATA, method)).toBe(HttpStatus.NO_CONTENT);
  });

  it("registers the token for the caller's account (from the JWT, never the body)", async () => {
    await controller.register(caller, {
      token: 'fcm-token-abc',
      platform: DevicePlatform.IOS,
    });

    expect(devices.register).toHaveBeenCalledWith('account-1', {
      token: 'fcm-token-abc',
      platform: DevicePlatform.IOS,
    });
  });

  it("unregisters the token from the caller's account", async () => {
    await controller.unregister(caller, 'fcm-token-abc');

    expect(devices.unregister).toHaveBeenCalledWith(
      'account-1',
      'fcm-token-abc',
    );
  });
});
