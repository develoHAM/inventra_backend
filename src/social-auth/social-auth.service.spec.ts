import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SocialAuthService } from './social-auth.service';
import { decryptToken } from '../common/token-cipher';
import { UserStatus } from '../generated/prisma/enums';
import type { SocialIdentity } from './verifiers/social-identity-verifier';

describe('SocialAuthService', () => {
  let service: SocialAuthService;
  let prisma: {
    userLoginMethod: { findUnique: jest.Mock; update: jest.Mock };
  };
  let nonces: { issue: jest.Mock; consume: jest.Mock };
  let verifiers: Record<string, { verify: jest.Mock; disconnect: jest.Mock }>;
  let tickets: { create: jest.Mock };
  let auth: { issueSessionFor: jest.Mock };

  const encryptionKey = Buffer.alloc(32, 7).toString('base64');
  const now = new Date('2026-10-22T10:00:00.000Z');

  const kakaoIdentity: SocialIdentity = {
    provider: 'kakao',
    providerUserId: '4012345678',
    email: 'owner@kakao.com',
    emailVerified: true,
    name: '김사장',
    refreshToken: null,
  };
  const googleIdentity: SocialIdentity = {
    provider: 'google',
    providerUserId: '109876543210',
    email: 'owner@gmail.com',
    emailVerified: true,
    name: 'Kim Owner',
    refreshToken: '1//google-refresh',
  };
  /** A login method row as findUnique returns it (with the user included). */
  const knownLogin = (userChanges: Record<string, unknown> = {}) => ({
    id: 'login-method-1',
    method: 'kakao',
    providerUserId: '4012345678',
    user: {
      id: 'user-1',
      status: UserStatus.ACTIVE,
      companyId: 'company-1',
      roleId: 2,
      deletedAt: null,
      ...userChanges,
    },
  });
  const kakaoBody = {
    provider: 'kakao' as const,
    credential: { idToken: 'kakao-id-token' },
    nonce: 'raw-nonce',
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: now });
    prisma = {
      userLoginMethod: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    nonces = {
      issue: jest.fn().mockResolvedValue({ nonce: 'n', expiresInSeconds: 300 }),
      consume: jest.fn().mockResolvedValue(true),
    };
    const verifierFor = (identity: SocialIdentity) => ({
      verify: jest.fn().mockResolvedValue(identity),
      disconnect: jest.fn(),
    });
    verifiers = {
      kakao: verifierFor(kakaoIdentity),
      google: verifierFor(googleIdentity),
      apple: verifierFor({ ...kakaoIdentity, provider: 'apple' }),
      facebook: verifierFor({ ...kakaoIdentity, provider: 'facebook' }),
    };
    tickets = {
      create: jest.fn().mockResolvedValue({
        signupToken: 'raw-signup-token',
        expiresInSeconds: 900,
        profile: {
          email: 'owner@kakao.com',
          emailVerified: true,
          name: '김사장',
        },
      }),
    };
    auth = {
      issueSessionFor: jest.fn().mockResolvedValue({
        accessToken: 'our-access',
        refreshToken: 'our-refresh',
      }),
    };
    const config = { get: jest.fn().mockReturnValue(encryptionKey) };
    service = new SocialAuthService(
      prisma as any,
      nonces as any,
      verifiers as any,
      tickets as any,
      auth as any,
      config as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('issueNonce hands out a nonce from SocialNonceService', async () => {
    await expect(service.issueNonce()).resolves.toEqual({
      nonce: 'n',
      expiresInSeconds: 300,
    });
  });

  describe('the nonce', () => {
    it('is spent BEFORE the provider is asked', async () => {
      await service.signIn(kakaoBody);

      expect(nonces.consume).toHaveBeenCalledWith('raw-nonce');
      expect(nonces.consume.mock.invocationCallOrder[0]).toBeLessThan(
        verifiers.kakao.verify.mock.invocationCallOrder[0],
      );
    });

    it('unknown, expired or already used → 401, the provider is never asked', async () => {
      nonces.consume.mockResolvedValue(false);

      await expect(service.signIn(kakaoBody)).rejects.toThrow(
        new UnauthorizedException('Invalid social credential'),
      );
      expect(verifiers.kakao.verify).not.toHaveBeenCalled();
    });

    it('none sent → nothing spent; the verifier decides if one was required', async () => {
      await service.signIn({
        provider: 'google',
        credential: { idToken: 'g' },
      });

      expect(nonces.consume).not.toHaveBeenCalled();
      expect(verifiers.google.verify).toHaveBeenCalledWith(
        { idToken: 'g' },
        undefined,
      );
    });
  });

  it("asks the route's provider, with the credential and the raw nonce", async () => {
    await service.signIn(kakaoBody);

    expect(verifiers.kakao.verify).toHaveBeenCalledWith(
      { idToken: 'kakao-id-token' },
      'raw-nonce',
    );
    expect(verifiers.google.verify).not.toHaveBeenCalled();
  });

  it.each([
    [
      '401 (bad credential)',
      new UnauthorizedException('Invalid social credential'),
    ],
    [
      '503 (provider unreachable)',
      new ServiceUnavailableException('Kakao could not be reached'),
    ],
  ])(
    'a verifier %s passes through; nothing is looked up',
    async (_label, failure) => {
      verifiers.kakao.verify.mockRejectedValue(failure);

      await expect(service.signIn(kakaoBody)).rejects.toBe(failure);
      expect(prisma.userLoginMethod.findUnique).not.toHaveBeenCalled();
    },
  );

  it('looks the identity up by (provider, provider user id) — never by email', async () => {
    await service.signIn(kakaoBody);

    expect(prisma.userLoginMethod.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          method_providerUserId: {
            method: 'kakao',
            providerUserId: '4012345678',
          },
        },
      }),
    );
  });

  describe('a new identity → SIGNUP_REQUIRED', () => {
    it('creates a signup ticket from the verified identity and returns it with the profile', async () => {
      await expect(service.signIn(kakaoBody)).resolves.toEqual({
        status: 'SIGNUP_REQUIRED',
        signupToken: 'raw-signup-token',
        expiresInSeconds: 900,
        profile: {
          email: 'owner@kakao.com',
          emailVerified: true,
          name: '김사장',
        },
      });
      expect(tickets.create).toHaveBeenCalledWith(kakaoIdentity);
    });

    it('issues no session', async () => {
      await service.signIn(kakaoBody);

      expect(auth.issueSessionFor).not.toHaveBeenCalled();
    });
  });

  describe('a known identity → LOGGED_IN', () => {
    beforeEach(() => {
      prisma.userLoginMethod.findUnique.mockResolvedValue(knownLogin());
    });

    it('issues OUR tokens, in the same shape as password login', async () => {
      await expect(service.signIn(kakaoBody)).resolves.toEqual({
        status: 'LOGGED_IN',
        accessToken: 'our-access',
        refreshToken: 'our-refresh',
        user: {
          id: 'user-1',
          status: UserStatus.ACTIVE,
          companyId: 'company-1',
          roleId: 2,
        },
      });
      expect(auth.issueSessionFor).toHaveBeenCalledWith('user-1');
      expect(tickets.create).not.toHaveBeenCalled();
    });

    it('records lastLoginAt; no new provider refresh token → the stored one is kept', async () => {
      await service.signIn(kakaoBody);

      expect(prisma.userLoginMethod.update).toHaveBeenCalledWith({
        where: { id: 'login-method-1' },
        data: { lastLoginAt: now },
      });
    });

    it('a new provider refresh token (Google) replaces the stored one, encrypted', async () => {
      prisma.userLoginMethod.findUnique.mockResolvedValue({
        ...knownLogin(),
        method: 'google',
      });

      await service.signIn({
        provider: 'google',
        credential: { idToken: 'g' },
      });

      const { data } = prisma.userLoginMethod.update.mock.calls[0][0];
      expect(data.lastLoginAt).toEqual(now);
      expect(data.refreshToken).not.toContain('1//google-refresh');
      expect(decryptToken(data.refreshToken, encryptionKey)).toBe(
        '1//google-refresh',
      );
    });

    it('a pending-approval user may sign in (same rule as password login)', async () => {
      prisma.userLoginMethod.findUnique.mockResolvedValue(
        knownLogin({ status: UserStatus.PENDING_APPROVAL }),
      );

      await expect(service.signIn(kakaoBody)).resolves.toMatchObject({
        status: 'LOGGED_IN',
      });
    });

    it.each([
      ['soft-deleted', { deletedAt: new Date('2026-10-01') }],
      ['suspended', { status: UserStatus.SUSPENDED }],
      ['rejected', { status: UserStatus.REJECTED }],
      ['deactivated', { status: UserStatus.DEACTIVATED }],
    ])(
      'a %s user → 401, no session, nothing updated',
      async (_label, changes) => {
        prisma.userLoginMethod.findUnique.mockResolvedValue(
          knownLogin(changes),
        );

        await expect(service.signIn(kakaoBody)).rejects.toThrow(
          new UnauthorizedException('Account cannot sign in'),
        );
        expect(auth.issueSessionFor).not.toHaveBeenCalled();
        expect(prisma.userLoginMethod.update).not.toHaveBeenCalled();
      },
    );
  });
});
