import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { DevicesController } from './devices.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../authorization/decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { AuthUser } from '../auth/types/auth-user';
import { DevicePlatform, UserStatus } from '../generated/prisma/enums';

describe('DevicesController', () => {
  let controller: DevicesController;
  let devices: { register: jest.Mock; unregister: jest.Mock };

  // a PENDING user may register a device: they should get the approval push
  const caller: AuthUser = {
    id: 'user-1',
    companyId: 'company-1',
    roleId: null,
    roleCode: null,
    status: UserStatus.PENDING_APPROVAL,
  };

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

  it.each(['register', 'unregister'] as const)('%s answers 204', (method) => {
    expect(metadata(HTTP_CODE_METADATA, method)).toBe(HttpStatus.NO_CONTENT);
  });

  it('registers the token for the caller (from the JWT, never the body)', async () => {
    await controller.register(caller, {
      token: 'fcm-token-abc',
      platform: DevicePlatform.IOS,
    });

    expect(devices.register).toHaveBeenCalledWith('user-1', {
      token: 'fcm-token-abc',
      platform: DevicePlatform.IOS,
    });
  });

  it("unregisters the caller's token", async () => {
    await controller.unregister(caller, 'fcm-token-abc');

    expect(devices.unregister).toHaveBeenCalledWith('user-1', 'fcm-token-abc');
  });
});
