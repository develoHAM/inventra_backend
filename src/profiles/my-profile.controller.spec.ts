import { RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { MyProfileController } from './my-profile.controller';
import { ProfilesController } from './profiles.controller';
import { ProfilesModule } from './profiles.module';
import { ACCOUNT_ROUTE_KEY } from '../auth/decorators/account-route.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { REQUIRE_PERMISSIONS_KEY } from '../authorization/decorators/require-permissions.decorator';
import { ProfileStatus } from '../generated/prisma/enums';
import type { AuthProfile } from '../auth/types/auth-profile';

describe('MyProfileController', () => {
  let controller: MyProfileController;
  let myProfile: { updateMyProfile: jest.Mock; setMyContactEmail: jest.Mock };

  const caller: AuthProfile = {
    id: 'profile-1',
    accountId: 'account-1',
    companyId: 'company-1',
    roleId: null,
    roleCode: null,
    status: ProfileStatus.PENDING_APPROVAL,
  };

  const metadata = (key: string, method: keyof MyProfileController) =>
    Reflect.getMetadata(key, MyProfileController.prototype[method]);

  beforeEach(() => {
    myProfile = {
      updateMyProfile: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      setMyContactEmail: jest.fn().mockResolvedValue({ id: 'profile-1' }),
    };
    controller = new MyProfileController(myProfile as any);
  });

  it('lives at /profiles/me', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MyProfileController)).toBe(
      'profiles/me',
    );
  });

  it('is NOT an @AccountRoute(): "me" is the open profile, so a company must be open', () => {
    expect(
      Reflect.getMetadata(ACCOUNT_ROUTE_KEY, MyProfileController),
    ).toBeUndefined();
    expect(metadata(ACCOUNT_ROUTE_KEY, 'updateMyProfile')).toBeUndefined();
    expect(metadata(ACCOUNT_ROUTE_KEY, 'setMyContactEmail')).toBeUndefined();
  });

  it.each(['updateMyProfile', 'setMyContactEmail'] as const)(
    '%s has no permission decorator, so a WAITING profile may use it (and it is not public)',
    (method) => {
      expect(metadata(REQUIRE_PERMISSIONS_KEY, method)).toBeUndefined();
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSIONS_KEY, MyProfileController),
      ).toBeUndefined();
      expect(metadata(IS_PUBLIC_KEY, method)).toBeUndefined();
    },
  );

  it.each([
    ['updateMyProfile', RequestMethod.PATCH, '/'],
    ['setMyContactEmail', RequestMethod.PUT, 'contact-email'],
  ] as const)(
    '%s is %s /profiles/me + %s, answering 200',
    (method, verb, path) => {
      expect(metadata(METHOD_METADATA, method)).toBe(verb);
      expect(metadata(PATH_METADATA, method)).toBe(path);
      expect(metadata(HTTP_CODE_METADATA, method)).toBeUndefined(); // the default: 200
    },
  );

  it('is registered BEFORE ProfilesController, so /profiles/me never falls into a /profiles/:id route', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ProfilesModule,
    ) as unknown[];

    expect(controllers.indexOf(MyProfileController)).toBeGreaterThanOrEqual(0);
    expect(controllers.indexOf(MyProfileController)).toBeLessThan(
      controllers.indexOf(ProfilesController),
    );
  });

  it('PATCH passes the open profile from the token and the body', async () => {
    await controller.updateMyProfile(caller, { name: 'Lee Ji-eun' });

    expect(myProfile.updateMyProfile).toHaveBeenCalledWith(caller, {
      name: 'Lee Ji-eun',
    });
  });

  it('PUT contact-email passes the open profile from the token and the body', async () => {
    const dto = {
      email: 'lee@acme.com',
      emailVerificationToken: 'email-token',
    };

    await controller.setMyContactEmail(caller, dto);

    expect(myProfile.setMyContactEmail).toHaveBeenCalledWith(caller, dto);
  });
});
