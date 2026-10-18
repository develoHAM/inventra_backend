import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  KAKAO_ISSUER,
  KAKAO_UNLINK_URL,
  KAKAO_USER_URL,
  KakaoVerifier,
} from './kakao.verifier';
import { nonceClaimFor } from '../social-nonce.service';
import { fakeProviderKeys } from '../../../test/helpers/provider-keys';

describe('KakaoVerifier', () => {
  let kakaoKeys: Awaited<ReturnType<typeof fakeProviderKeys>>;
  let verifier: KakaoVerifier;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  const settings = {
    nativeAppKey: 'our-native-app-key',
    adminKey: 'our-admin-key',
  };
  const rawNonce = 'raw-nonce-from-our-server';

  // a stand-in for the Response object fetch() resolves with
  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status: status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  });
  const verifiedAccount = {
    id: 4012345678,
    kakao_account: {
      email: 'owner@kakao.com',
      is_email_valid: true,
      is_email_verified: true,
    },
  };

  /** What the Kakao SDK hands the app: an ID token for us, bound to our nonce. */
  const kakaoIdToken = (claims: Record<string, unknown> = {}) =>
    kakaoKeys.sign({
      iss: KAKAO_ISSUER,
      aud: settings.nativeAppKey,
      sub: '4012345678',
      nonce: nonceClaimFor(rawNonce),
      nickname: '김사장',
      email: 'owner@kakao.com',
      ...claims,
    });

  beforeAll(async () => {
    kakaoKeys = await fakeProviderKeys();
  });

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(respond(200, verifiedAccount));
    global.fetch = fetchMock;
    verifier = new KakaoVerifier(settings, kakaoKeys.keySet);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('verify', () => {
    it('maps a valid ID token to the identity', async () => {
      const idToken = await kakaoIdToken();

      await expect(
        verifier.verify({ idToken: idToken }, rawNonce),
      ).resolves.toEqual({
        provider: 'kakao',
        providerUserId: '4012345678',
        email: 'owner@kakao.com',
        emailVerified: true,
        name: '김사장',
        refreshToken: null,
      });
    });

    it("rejects a token issued for another app's key (aud) → 401", async () => {
      const idToken = await kakaoIdToken({ aud: 'another-kakao-app' });

      await expect(
        verifier.verify({ idToken: idToken }, rawNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([
      ['no nonce from the app', undefined],
      ['a different nonce', 'replayed-or-stolen'],
    ])('the nonce is required: %s → 401', async (_label, sentNonce) => {
      const idToken = await kakaoIdToken();

      await expect(
        verifier.verify({ idToken: idToken }, sentNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a token not bound to any nonce → 401 (Kakao always binds ours)', async () => {
      const idToken = await kakaoIdToken({ nonce: undefined });

      await expect(
        verifier.verify({ idToken: idToken }, rawNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a credential without idToken → 401', async () => {
      await expect(
        verifier.verify({ accessToken: 'wrong-field' }, rawNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('no email consent → email null, unverified, and no lookup', async () => {
      const idToken = await kakaoIdToken({
        email: undefined,
        nickname: undefined,
      });

      await expect(
        verifier.verify({ idToken: idToken }, rawNonce),
      ).resolves.toMatchObject({
        email: null,
        emailVerified: false,
        name: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('is the email verified? (the ID token has no email_verified claim)', () => {
    it('asks Kakao with the admin key, for this user', async () => {
      await verifier.verify({ idToken: await kakaoIdToken() }, rawNonce);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        `${KAKAO_USER_URL}?target_id_type=user_id&target_id=4012345678`,
      );
      expect(init.headers).toEqual({ Authorization: 'KakaoAK our-admin-key' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([
      ['not verified', { is_email_verified: false }],
      [
        'no longer valid (taken by another Kakao account)',
        { is_email_valid: false },
      ],
      ['a different email than the token’s', { email: 'new@kakao.com' }],
      [
        'flags missing',
        { is_email_valid: undefined, is_email_verified: undefined },
      ],
    ])('Kakao says %s → unverified', async (_label, change) => {
      fetchMock.mockResolvedValue(
        respond(200, {
          kakao_account: { ...verifiedAccount.kakao_account, ...change },
        }),
      );

      await expect(
        verifier.verify({ idToken: await kakaoIdToken() }, rawNonce),
      ).resolves.toMatchObject({
        email: 'owner@kakao.com',
        emailVerified: false,
      });
    });

    it.each([
      [
        'Kakao answers 401 (bad admin key)',
        () => fetchMock.mockResolvedValue(respond(401, { code: -401 })),
      ],
      [
        'Kakao unreachable',
        () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
      ],
    ])(
      '%s → sign-in still works, email unverified, a warning logged',
      async (_label, fail) => {
        fail();

        await expect(
          verifier.verify({ idToken: await kakaoIdToken() }, rawNonce),
        ).resolves.toMatchObject({
          providerUserId: '4012345678',
          emailVerified: false,
        });
        expect(Logger.prototype.warn).toHaveBeenCalled();
      },
    );
  });

  describe('disconnect', () => {
    it('unlinks the user with the admin key', async () => {
      fetchMock.mockResolvedValue(respond(200, { id: 4012345678 }));

      await verifier.disconnect({
        providerUserId: '4012345678',
        refreshToken: null,
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(KAKAO_UNLINK_URL);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Authorization: 'KakaoAK our-admin-key',
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      });
      expect(init.body).toBe('target_id_type=user_id&target_id=4012345678');
    });

    it('a Kakao error is thrown (the caller logs it: unlink is best-effort)', async () => {
      fetchMock.mockResolvedValue(respond(400, { code: -101 }));

      await expect(
        verifier.disconnect({
          providerUserId: '4012345678',
          refreshToken: null,
        }),
      ).rejects.toThrow('Kakao unlink responded 400');
    });
  });
});
