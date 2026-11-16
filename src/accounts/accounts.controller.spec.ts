import { RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { AccountsController } from './accounts.controller';
import { ACCOUNT_ROUTE_KEY } from '../auth/decorators/account-route.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { REQUIRE_PERMISSIONS_KEY } from '../authorization/decorators/require-permissions.decorator';
import type { AuthAccount } from '../auth/types/auth-account';

describe('AccountsController', () => {
  let controller: AccountsController;
  let accounts: { listCompanies: jest.Mock };
  let accountCompanies: { join: jest.Mock; create: jest.Mock };

  // joining and creating are for a sign-in with no company open (yet)
  const account: AuthAccount = { accountId: 'account-1', profileId: null };

  const metadata = (key: string, method: keyof AccountsController) =>
    Reflect.getMetadata(key, AccountsController.prototype[method]);

  beforeEach(() => {
    accounts = { listCompanies: jest.fn().mockResolvedValue([]) };
    accountCompanies = {
      join: jest.fn().mockResolvedValue({ profileId: 'profile-new' }),
      create: jest.fn().mockResolvedValue({ profileId: 'profile-new' }),
    };
    controller = new AccountsController(
      accounts as any,
      accountCompanies as any,
    );
  });

  it('lives at /me, and the whole controller is an @AccountRoute(): no company needs to be open', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AccountsController)).toBe('me');
    expect(Reflect.getMetadata(ACCOUNT_ROUTE_KEY, AccountsController)).toBe(
      true,
    );
  });

  it.each(['listCompanies', 'join', 'create'] as const)(
    '%s needs a sign-in but no permission (not public, no @RequirePermissions)',
    (method) => {
      expect(metadata(IS_PUBLIC_KEY, method)).toBeUndefined();
      expect(metadata(REQUIRE_PERMISSIONS_KEY, method)).toBeUndefined();
    },
  );

  it.each([
    ['listCompanies', RequestMethod.GET, 'companies'],
    ['join', RequestMethod.POST, 'companies/join'],
    ['create', RequestMethod.POST, 'companies'],
  ] as const)('%s is %s /me/%s', (method, httpMethod, path) => {
    expect(metadata(METHOD_METADATA, method)).toBe(httpMethod);
    expect(metadata(PATH_METADATA, method)).toBe(path);
  });

  it.each(['join', 'create'] as const)(
    '%s answers 201 Created (the POST default: no @HttpCode)',
    (method) => {
      expect(metadata(HTTP_CODE_METADATA, method)).toBeUndefined();
    },
  );

  it("GET /me/companies lists the caller's own companies", async () => {
    await controller.listCompanies(account);

    expect(accounts.listCompanies).toHaveBeenCalledWith('account-1');
  });

  it('POST /me/companies/join passes the account from the JWT and the body', async () => {
    const dto = { joinCode: '48291307', name: 'Sam' };

    await expect(controller.join(account, dto)).resolves.toEqual({
      profileId: 'profile-new',
    });
    expect(accountCompanies.join).toHaveBeenCalledWith(account, dto);
  });

  it('POST /me/companies passes the account from the JWT and the body', async () => {
    const dto = {
      companyName: 'New Co',
      taxId: '123-45-67890',
      ownerName: 'Owner Kim',
    };

    await expect(controller.create(account, dto)).resolves.toEqual({
      profileId: 'profile-new',
    });
    expect(accountCompanies.create).toHaveBeenCalledWith(account, dto);
  });
});
