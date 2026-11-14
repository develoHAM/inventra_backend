import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ProfileStatus } from '../../generated/prisma/enums';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ACCOUNT_ROUTE_KEY } from '../decorators/account-route.decorator';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let tokenService: { verifyAccess: jest.Mock };
  let prisma: {
    profile: { findUnique: jest.Mock };
    account: { findUnique: jest.Mock };
  };

  /** profile-1 of account-1, as the guard's query returns it (with its account). */
  const activeProfile = {
    id: 'profile-1',
    accountId: 'account-1',
    companyId: 'company-1',
    companyStoreId: 'store-1',
    roleId: 2,
    status: ProfileStatus.ACTIVE,
    deletedAt: null,
    role: { code: 'OWNER' },
    account: { deletedAt: null },
  };

  /** What the access token says: the account, and the open profile (or none). */
  const profileToken = { accountId: 'account-1', profileId: 'profile-1' };
  const profileLessToken = { accountId: 'account-1', profileId: null };

  const handler = () => undefined;
  class SomeController {}

  // A guard receives an ExecutionContext, not plain arguments. The guard only
  // touches three of its methods, so we fake exactly those three.
  function contextWith(request: any): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => SomeController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  /** How the route is marked: @Public(), @AccountRoute(), or neither (a company route). */
  function routeMarked(marks: {
    isPublic?: boolean;
    isAccountRoute?: boolean;
  }) {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === IS_PUBLIC_KEY) return marks.isPublic;
      if (key === ACCOUNT_ROUTE_KEY) return marks.isAccountRoute;
      return undefined;
    });
  }

  const bearer = () => ({ headers: { authorization: 'Bearer good-token' } });

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    tokenService = { verifyAccess: jest.fn() };
    prisma = {
      profile: { findUnique: jest.fn() },
      account: { findUnique: jest.fn() },
    };
    guard = new JwtAuthGuard(
      reflector as any,
      tokenService as any,
      prisma as any,
    );
    routeMarked({}); // a company route unless a test says otherwise
  });

  describe('before the token is read (unchanged)', () => {
    it('allows public routes without a token', async () => {
      routeMarked({ isPublic: true });
      const request = { headers: {} };

      await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
      expect(tokenService.verifyAccess).not.toHaveBeenCalled();
    });

    it('rejects a request with no Authorization header', async () => {
      const request = { headers: {} };

      await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a malformed Authorization header', async () => {
      const request = { headers: { authorization: 'Basic abc' } };

      await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(tokenService.verifyAccess).not.toHaveBeenCalled();
    });

    it('rejects an invalid or expired token', async () => {
      tokenService.verifyAccess.mockRejectedValue(new Error('invalid'));

      await expect(guard.canActivate(contextWith(bearer()))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('a token with a profile open', () => {
    beforeEach(() => {
      tokenService.verifyAccess.mockResolvedValue(profileToken);
      prisma.profile.findUnique.mockResolvedValue(activeProfile);
    });

    it('sets request.account and request.profile (the AuthProfile, no deletedAt or account leak)', async () => {
      const request: any = bearer();

      await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);

      expect(request.account).toEqual({
        accountId: 'account-1',
        profileId: 'profile-1',
      });
      expect(request.profile).toEqual({
        id: 'profile-1',
        accountId: 'account-1',
        companyId: 'company-1',
        companyStoreId: 'store-1',
        roleId: 2,
        roleCode: 'OWNER',
        status: ProfileStatus.ACTIVE,
      });
    });

    it("loads the profile fresh, with its account's deletedAt, in ONE query", async () => {
      await guard.canActivate(contextWith(bearer()));

      expect(prisma.profile.findUnique).toHaveBeenCalledWith({
        where: { id: 'profile-1' },
        select: {
          id: true,
          accountId: true,
          companyId: true,
          companyStoreId: true,
          roleId: true,
          status: true,
          deletedAt: true,
          role: { select: { code: true } },
          account: { select: { deletedAt: true } },
        },
      });
      expect(prisma.account.findUnique).not.toHaveBeenCalled();
    });

    it("Review Focus 1: a pid naming ANOTHER account's profile → 401, never acts as it", async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...activeProfile,
        accountId: 'account-2', // the profile exists, but it is someone else's
      });
      const request: any = bearer();

      await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(request.profile).toBeUndefined();
      expect(request.account).toBeUndefined();
    });

    it('the profile no longer exists → 401', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);

      await expect(guard.canActivate(contextWith(bearer()))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a soft-deleted account → 401, even though the profile itself is fine', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...activeProfile,
        account: { deletedAt: new Date('2026-11-01') },
      });

      await expect(guard.canActivate(contextWith(bearer()))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a soft-deleted profile → 401', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...activeProfile,
        deletedAt: new Date(),
      });

      await expect(guard.canActivate(contextWith(bearer()))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a profile that is not openable (suspended) → 401', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...activeProfile,
        status: ProfileStatus.SUSPENDED,
      });

      await expect(guard.canActivate(contextWith(bearer()))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a PENDING profile passes (activation is enforced downstream)', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...activeProfile,
        status: ProfileStatus.PENDING_APPROVAL,
      });
      const request: any = bearer();

      await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
      expect(request.profile.status).toBe(ProfileStatus.PENDING_APPROVAL);
    });

    it('also passes an @AccountRoute(), with the profile still set', async () => {
      routeMarked({ isAccountRoute: true });
      const request: any = bearer();

      await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
      expect(request.profile.id).toBe('profile-1');
    });
  });

  describe('a token with no profile open', () => {
    beforeEach(() => {
      tokenService.verifyAccess.mockResolvedValue(profileLessToken);
      prisma.account.findUnique.mockResolvedValue({ deletedAt: null });
    });

    it('Review Focus 2: on a company route (unmarked) → 403 Choose a company first', async () => {
      const request: any = bearer();

      await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
        new ForbiddenException('Choose a company first'),
      );
      expect(request.profile).toBeUndefined();
      expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    });

    it('on an @AccountRoute() → passes: request.account set, request.profile undefined', async () => {
      routeMarked({ isAccountRoute: true });
      const request: any = bearer();

      await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);

      expect(request.account).toEqual({
        accountId: 'account-1',
        profileId: null,
      });
      expect(request.profile).toBeUndefined();
      expect(prisma.account.findUnique).toHaveBeenCalledWith({
        where: { id: 'account-1' },
        select: { deletedAt: true },
      });
    });

    it('reads @AccountRoute() from the handler first, then the controller class', async () => {
      routeMarked({ isAccountRoute: true });

      await guard.canActivate(contextWith(bearer()));

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
        ACCOUNT_ROUTE_KEY,
        [handler, SomeController],
      );
    });

    it.each([
      ['soft-deleted', { deletedAt: new Date('2026-11-01') }],
      ['missing', null],
    ])(
      'a %s account → 401, even on an @AccountRoute()',
      async (_label, account) => {
        routeMarked({ isAccountRoute: true });
        prisma.account.findUnique.mockResolvedValue(account);

        await expect(guard.canActivate(contextWith(bearer()))).rejects.toThrow(
          UnauthorizedException,
        );
      },
    );

    it('a deleted account on a company route → 401 (a dead sign-in), not 403', async () => {
      prisma.account.findUnique.mockResolvedValue({
        deletedAt: new Date('2026-11-01'),
      });

      await expect(guard.canActivate(contextWith(bearer()))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
