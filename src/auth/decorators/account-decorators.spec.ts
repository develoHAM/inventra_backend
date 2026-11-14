import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ACCOUNT_ROUTE_KEY, AccountRoute } from './account-route.decorator';
import { CurrentAccount } from './current-account.decorator';

describe('@AccountRoute()', () => {
  it('marks a route with ACCOUNT_ROUTE_KEY = true, like @Public() marks IS_PUBLIC_KEY', () => {
    class SomeController {
      @AccountRoute()
      handler() {}
    }

    expect(
      Reflect.getMetadata(ACCOUNT_ROUTE_KEY, SomeController.prototype.handler),
    ).toBe(true);
  });

  it('can mark a whole controller class', () => {
    @AccountRoute()
    class SomeController {}

    expect(Reflect.getMetadata(ACCOUNT_ROUTE_KEY, SomeController)).toBe(true);
  });
});

describe('@CurrentAccount()', () => {
  // A param decorator stores a factory in the route-args metadata; Nest calls
  // it with (data, ExecutionContext) for each request. Pull it out and call it.
  function factoryOf(): (data: unknown, context: ExecutionContext) => unknown {
    class SomeController {
      handler(@CurrentAccount() account: unknown) {
        return account;
      }
    }
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      SomeController,
      'handler',
    );
    return args[Object.keys(args)[0]].factory;
  }

  const contextWith = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  it('returns request.account (what the guard set), not request.profile', () => {
    const request = {
      account: { accountId: 'account-1', profileId: null },
      profile: { id: 'profile-1' },
    };

    expect(factoryOf()(undefined, contextWith(request))).toEqual({
      accountId: 'account-1',
      profileId: null,
    });
  });
});
