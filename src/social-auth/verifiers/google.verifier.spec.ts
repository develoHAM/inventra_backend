import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleVerifier,
} from './google.verifier';
import { nonceClaimFor } from '../social-nonce.service';
import { fakeProviderKeys } from '../../../test/helpers/provider-keys';

describe('GoogleVerifier', () => {
  let googleKeys: Awaited<ReturnType<typeof fakeProviderKeys>>;
  let verifier: GoogleVerifier;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  const settings = {
    audiences: [
      'web-client.apps.googleusercontent.com',
      'ios-client.apps.googleusercontent.com',
    ],
    webClientId: 'web-client.apps.googleusercontent.com',
    clientSecret: 'web-client-secret',
  };
  const rawNonce = 'raw-nonce-from-our-server';

  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status: status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  });

  /** What Google Sign-In hands the app: an ID token for our web client. */
  const googleIdToken = (claims: Record<string, unknown> = {}) =>
    googleKeys.sign({
      iss: 'https://accounts.google.com',
      aud: settings.webClientId,
      sub: '109876543210',
      email: 'owner@gmail.com',
      email_verified: true,
      name: 'Kim Owner',
      ...claims,
    });

  /** Google's token endpoint answer on the user's first consent. */
  const exchangeAnswer = async (sub = '109876543210') => ({
    access_token: 'ya29.access',
    refresh_token: '1//google-refresh',
    id_token: await googleKeys.sign({ sub: sub }),
  });

  beforeAll(async () => {
    googleKeys = await fakeProviderKeys();
  });

  beforeEach(async () => {
    fetchMock = jest
      .fn()
      .mockResolvedValue(respond(200, await exchangeAnswer()));
    global.fetch = fetchMock;
    verifier = new GoogleVerifier(settings, googleKeys.keySet);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('verify', () => {
    it('maps a valid ID token + server auth code to the identity', async () => {
      const credential = {
        idToken: await googleIdToken(),
        serverAuthCode: '4/0Aserver-auth-code',
      };

      await expect(verifier.verify(credential)).resolves.toEqual({
        provider: 'google',
        providerUserId: '109876543210',
        email: 'owner@gmail.com',
        emailVerified: true,
        name: 'Kim Owner',
        refreshToken: '1//google-refresh',
      });
    });

    it.each(['https://accounts.google.com', 'accounts.google.com'])(
      'accepts the issuer spelled %s',
      async (issuer) => {
        const idToken = await googleIdToken({ iss: issuer });

        await expect(
          verifier.verify({ idToken: idToken }),
        ).resolves.toMatchObject({
          providerUserId: '109876543210',
        });
      },
    );

    it('accepts a token for any of our client ids (iOS)', async () => {
      const idToken = await googleIdToken({
        aud: 'ios-client.apps.googleusercontent.com',
      });

      await expect(
        verifier.verify({ idToken: idToken }),
      ).resolves.toMatchObject({
        providerUserId: '109876543210',
      });
    });

    it("rejects a token for someone else's client id → 401", async () => {
      const idToken = await googleIdToken({
        aud: 'other-app.apps.googleusercontent.com',
      });

      await expect(
        verifier.verify({ idToken: idToken }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    describe('nonce (optional for Google)', () => {
      it('a token without one passes without a nonce', async () => {
        const idToken = await googleIdToken();

        await expect(
          verifier.verify({ idToken: idToken }),
        ).resolves.toBeDefined();
      });

      it('a token bound to our nonce passes with it', async () => {
        const idToken = await googleIdToken({ nonce: nonceClaimFor(rawNonce) });

        await expect(
          verifier.verify({ idToken: idToken }, rawNonce),
        ).resolves.toBeDefined();
      });

      it.each([
        ['missing', undefined],
        ['different', 'replayed-or-stolen'],
      ])(
        'a token bound to a nonce, with the nonce %s → 401',
        async (_label, sent) => {
          const idToken = await googleIdToken({
            nonce: nonceClaimFor(rawNonce),
          });

          await expect(
            verifier.verify({ idToken: idToken }, sent),
          ).rejects.toBeInstanceOf(UnauthorizedException);
        },
      );
    });

    it.each([
      [
        'email_verified false',
        { email_verified: false },
        'owner@gmail.com',
        false,
      ],
      [
        'email_verified as the string "true"',
        { email_verified: 'true' },
        'owner@gmail.com',
        true,
      ],
      [
        'email_verified missing',
        { email_verified: undefined },
        'owner@gmail.com',
        false,
      ],
      [
        'no email scope',
        { email: undefined, email_verified: undefined },
        null,
        false,
      ],
    ])('%s', async (_label, claims, email, emailVerified) => {
      const idToken = await googleIdToken(claims);

      await expect(
        verifier.verify({ idToken: idToken }),
      ).resolves.toMatchObject({
        email: email,
        emailVerified: emailVerified,
      });
    });
  });

  describe('serverAuthCode → refresh token', () => {
    it('exchanges the code at the token endpoint as the web client', async () => {
      await verifier.verify({
        idToken: await googleIdToken(),
        serverAuthCode: '4/0Aserver-auth-code',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(GOOGLE_TOKEN_URL);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
        grant_type: 'authorization_code',
        code: '4/0Aserver-auth-code',
        client_id: 'web-client.apps.googleusercontent.com',
        client_secret: 'web-client-secret',
        redirect_uri: '',
      });
    });

    it('no serverAuthCode → no exchange, refreshToken null', async () => {
      await expect(
        verifier.verify({ idToken: await googleIdToken() }),
      ).resolves.toMatchObject({ refreshToken: null });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a returning user (Google sends no refresh token) → null, no warning', async () => {
      fetchMock.mockResolvedValue(
        respond(200, { access_token: 'ya29.access', id_token: 'unused' }),
      );

      await expect(
        verifier.verify({
          idToken: await googleIdToken(),
          serverAuthCode: '4/0Aserver-auth-code',
        }),
      ).resolves.toMatchObject({ refreshToken: null });
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it("a code for a DIFFERENT Google user → that user's grant is not kept", async () => {
      fetchMock.mockResolvedValue(
        respond(200, await exchangeAnswer('someone-else')),
      );

      await expect(
        verifier.verify({
          idToken: await googleIdToken(),
          serverAuthCode: '4/0Aanother-users-code',
        }),
      ).resolves.toMatchObject({
        providerUserId: '109876543210',
        refreshToken: null,
      });
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it.each([
      [
        'invalid_grant (code used or expired)',
        () =>
          fetchMock.mockResolvedValue(respond(400, { error: 'invalid_grant' })),
      ],
      [
        'Google unreachable',
        () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
      ],
    ])(
      '%s → sign-in still works, refreshToken null, warning logged',
      async (_label, fail) => {
        fail();

        await expect(
          verifier.verify({
            idToken: await googleIdToken(),
            serverAuthCode: '4/0Aserver-auth-code',
          }),
        ).resolves.toMatchObject({
          providerUserId: '109876543210',
          refreshToken: null,
        });
        expect(Logger.prototype.warn).toHaveBeenCalled();
      },
    );
  });

  describe('disconnect', () => {
    it('revokes the refresh token', async () => {
      fetchMock.mockResolvedValue(respond(200, {}));

      await verifier.disconnect({
        providerUserId: '109876543210',
        refreshToken: '1//google-refresh',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(GOOGLE_REVOKE_URL);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('token=1%2F%2Fgoogle-refresh');
    });

    it('no stored refresh token → nothing to revoke, no call', async () => {
      await verifier.disconnect({
        providerUserId: '109876543210',
        refreshToken: null,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a Google error is thrown (the caller logs it: best-effort)', async () => {
      fetchMock.mockResolvedValue(respond(400, { error: 'invalid_token' }));

      await expect(
        verifier.disconnect({
          providerUserId: '109876543210',
          refreshToken: '1//google-refresh',
        }),
      ).rejects.toThrow('Google revoke responded 400');
    });
  });
});
