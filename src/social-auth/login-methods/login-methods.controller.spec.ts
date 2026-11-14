import { HttpStatus } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginMethodsController } from './login-methods.controller';
import { LinkPasswordDto } from './dto/link-password.dto';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { REQUIRE_PERMISSIONS_KEY } from '../../authorization/decorators/require-permissions.decorator';
import { ACCOUNT_ROUTE_KEY } from '../../auth/decorators/account-route.decorator';
import type { AuthAccount } from '../../auth/types/auth-account';

describe('LoginMethodsController', () => {
  let controller: LoginMethodsController;
  let loginMethods: {
    list: jest.Mock;
    linkProvider: jest.Mock;
    linkPassword: jest.Mock;
    unlink: jest.Mock;
  };

  const caller: AuthAccount = { accountId: 'account-1', profileId: null };
  const metadata = (key: string, method: keyof LoginMethodsController) =>
    Reflect.getMetadata(key, LoginMethodsController.prototype[method]);

  beforeEach(() => {
    loginMethods = {
      list: jest.fn().mockResolvedValue([]),
      linkProvider: jest.fn().mockResolvedValue({ id: 'lm-new' }),
      linkPassword: jest.fn().mockResolvedValue({ id: 'lm-local' }),
      unlink: jest.fn().mockResolvedValue(undefined),
    };
    controller = new LoginMethodsController(loginMethods as any);
  });

  it('the whole controller is an @AccountRoute(): login methods belong to the sign-in, no company needed', () => {
    expect(Reflect.getMetadata(ACCOUNT_ROUTE_KEY, LoginMethodsController)).toBe(
      true,
    );
  });

  it('lives under /accounts/me/login-methods', () => {
    expect(Reflect.getMetadata(PATH_METADATA, LoginMethodsController)).toBe(
      'accounts/me/login-methods',
    );
  });

  it.each([
    ['list', RequestMethod.GET, '/'],
    ['linkProvider', RequestMethod.POST, '/'],
    ['linkPassword', RequestMethod.POST, 'local'],
    ['unlink', RequestMethod.DELETE, ':id'],
  ] as const)('%s → %s %s', (method, httpMethod, path) => {
    expect(metadata(METHOD_METADATA, method)).toBe(httpMethod);
    expect(metadata(PATH_METADATA, method)).toBe(path);
  });

  it.each(['list', 'linkProvider', 'linkPassword', 'unlink'] as const)(
    '%s needs a signed-in user but no permission (it is their own account)',
    (method) => {
      expect(metadata(IS_PUBLIC_KEY, method)).toBeUndefined();
      expect(metadata(REQUIRE_PERMISSIONS_KEY, method)).toBeUndefined();
    },
  );

  it('unlink answers 204', () => {
    expect(metadata(HTTP_CODE_METADATA, 'unlink')).toBe(HttpStatus.NO_CONTENT);
  });

  it("every route acts on the caller's account from the JWT, never an id from the body", async () => {
    const linkBody = {
      provider: 'apple' as const,
      credential: { identityToken: 't' },
    };
    const passwordDto = {
      email: 'owner@example.com',
      password: 'brand-new-password',
      emailVerificationToken: 'raw-email-token',
    };

    await controller.list(caller);
    await controller.linkProvider(caller, linkBody);
    await controller.linkPassword(caller, passwordDto);
    await controller.unlink(caller, 'lm-1');

    expect(loginMethods.list).toHaveBeenCalledWith('account-1');
    expect(loginMethods.linkProvider).toHaveBeenCalledWith(
      'account-1',
      linkBody,
    );
    expect(loginMethods.linkPassword).toHaveBeenCalledWith(
      'account-1',
      passwordDto,
    );
    expect(loginMethods.unlink).toHaveBeenCalledWith('account-1', 'lm-1');
  });
});

describe('LinkPasswordDto', () => {
  const validBody = {
    email: 'owner@example.com',
    password: 'brand-new-password',
    emailVerificationToken: 'raw-email-token',
  };

  async function check(body: Record<string, unknown>) {
    const instance = plainToInstance(LinkPasswordDto, body);
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return {
      instance: instance,
      failedFields: errors.map((error) => error.property),
    };
  }

  it('accepts a valid body and normalizes the email like the verification did', async () => {
    const { instance, failedFields } = await check({
      ...validBody,
      email: '  Owner@Example.COM ',
    });

    expect(failedFields).toEqual([]);
    expect(instance.email).toBe('owner@example.com');
  });

  it.each(['email', 'password', 'emailVerificationToken'])(
    'requires %s',
    async (field) => {
      const body: Record<string, unknown> = { ...validBody };
      delete body[field];

      const { failedFields } = await check(body);

      expect(failedFields).toEqual([field]);
    },
  );

  it.each([
    ['too short (7)', 'short12'],
    ['too long (129)', 'x'.repeat(129)],
  ])(
    'rejects a password that is %s — same rule as signup',
    async (_label, password) => {
      const { failedFields } = await check({
        ...validBody,
        password: password,
      });

      expect(failedFields).toEqual(['password']);
    },
  );

  it('rejects unknown fields (e.g. an accountId: the caller comes from the JWT)', async () => {
    const { failedFields } = await check({
      ...validBody,
      accountId: 'someone-else',
    });

    expect(failedFields).toEqual(['accountId']);
  });
});
