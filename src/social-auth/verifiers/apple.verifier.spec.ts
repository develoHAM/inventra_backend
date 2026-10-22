import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import type { CryptoKey } from 'jose';
import {
  APPLE_ISSUER,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  AppleVerifier,
} from './apple.verifier';
import { nonceClaimFor } from '../social-nonce.service';
import { fakeProviderKeys } from '../../../test/helpers/provider-keys';

describe('AppleVerifier', () => {
  let appleKeys: Awaited<ReturnType<typeof fakeProviderKeys>>;
  let ourKeyPublicHalf: CryptoKey; // checks the client secrets we sign
  let settings: {
    teamId: string;
    keyId: string;
    privateKeyPem: string;
    bundleId: string;
  };
  let verifier: AppleVerifier;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  const rawNonce = 'raw-nonce-from-our-server';
  const appleUserId = '001234.0a1b2c3d4e5f.0123';

  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status: status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  });

  /** What expo-apple-authentication hands the app: an identity token for our bundle id. */
  const appleIdentityToken = (claims: Record<string, unknown> = {}) =>
    appleKeys.sign({
      iss: APPLE_ISSUER,
      aud: 'com.inventra.app',
      sub: appleUserId,
      nonce: nonceClaimFor(rawNonce),
      email: 'x7k2@privaterelay.appleid.com',
      email_verified: 'true', // Apple's string
      is_private_email: 'true',
      ...claims,
    });

  /** Apple's /auth/token answer. */
  const tokenAnswer = async (sub = appleUserId) => ({
    access_token: 'a-apple',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'r-apple',
    id_token: await appleKeys.sign({ sub: sub }),
  });

  /** The form a fetch call sent, as an object. */
  const sentForm = (call: number) =>
    Object.fromEntries(
      new URLSearchParams(fetchMock.mock.calls[call][1].body as string),
    );

  beforeAll(async () => {
    appleKeys = await fakeProviderKeys();
    // stands in for the .p8 file from App Store Connect (an ES256 private key)
    const ourKey = await generateKeyPair('ES256', { extractable: true });
    ourKeyPublicHalf = ourKey.publicKey;
    settings = {
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      privateKeyPem: await exportPKCS8(ourKey.privateKey),
      bundleId: 'com.inventra.app',
    };
  });

  beforeEach(async () => {
    fetchMock = jest.fn().mockResolvedValue(respond(200, await tokenAnswer()));
    global.fetch = fetchMock;
    verifier = new AppleVerifier(settings, appleKeys.keySet);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('verify', () => {
    it('maps the first sign-in (with name and code) to the identity', async () => {
      const credential = {
        identityToken: await appleIdentityToken(),
        authorizationCode: 'c-apple-code',
        fullName: '김 사장',
      };

      await expect(verifier.verify(credential, rawNonce)).resolves.toEqual({
        provider: 'apple',
        providerUserId: appleUserId,
        email: 'x7k2@privaterelay.appleid.com',
        emailVerified: true,
        name: '김 사장',
        refreshToken: 'r-apple',
      });
    });

    it('a later sign-in (no fullName) still verifies, with name null', async () => {
      const credential = { identityToken: await appleIdentityToken() };

      await expect(
        verifier.verify(credential, rawNonce),
      ).resolves.toMatchObject({
        providerUserId: appleUserId,
        name: null,
        refreshToken: null,
      });
    });

    it.each([
      [
        'Apple’s name object',
        { givenName: 'Owner', familyName: 'Kim' },
        'Owner Kim',
      ],
      ['only a given name', { givenName: 'Owner', familyName: null }, 'Owner'],
      ['blank strings', { givenName: ' ', familyName: '' }, null],
      ['a blank string', '   ', null],
      ['something else', 42, null],
    ])('fullName as %s', async (_label, fullName, expected) => {
      const credential = {
        identityToken: await appleIdentityToken(),
        fullName: fullName,
      };

      await expect(
        verifier.verify(credential, rawNonce),
      ).resolves.toMatchObject({
        name: expected,
      });
    });

    it.each([
      [
        '"false"',
        { email_verified: 'false' },
        'x7k2@privaterelay.appleid.com',
        false,
      ],
      [
        'a boolean true',
        { email_verified: true },
        'x7k2@privaterelay.appleid.com',
        true,
      ],
      [
        'no email shared',
        { email: undefined, email_verified: undefined },
        null,
        false,
      ],
    ])('email_verified %s', async (_label, claims, email, emailVerified) => {
      const credential = { identityToken: await appleIdentityToken(claims) };

      await expect(
        verifier.verify(credential, rawNonce),
      ).resolves.toMatchObject({
        email: email,
        emailVerified: emailVerified,
      });
    });

    it('a token for another app’s bundle id → 401', async () => {
      const credential = {
        identityToken: await appleIdentityToken({ aud: 'com.other.app' }),
      };

      await expect(
        verifier.verify(credential, rawNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([
      ['no nonce from the app', undefined],
      ['a different nonce', 'replayed-or-stolen'],
    ])('the nonce is required: %s → 401', async (_label, sentNonce) => {
      const credential = { identityToken: await appleIdentityToken() };

      await expect(
        verifier.verify(credential, sentNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a credential without identityToken → 401', async () => {
      await expect(
        verifier.verify({ idToken: 'wrong-field' }, rawNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('authorizationCode → refresh token', () => {
    it('exchanges the code with a client secret WE signed (ES256, our .p8 key)', async () => {
      await verifier.verify(
        {
          identityToken: await appleIdentityToken(),
          authorizationCode: 'c-apple-code',
        },
        rawNonce,
      );

      expect(fetchMock.mock.calls[0][0]).toBe(APPLE_TOKEN_URL);
      const form = sentForm(0);
      expect(form).toMatchObject({
        grant_type: 'authorization_code',
        code: 'c-apple-code',
        client_id: 'com.inventra.app',
      });

      // the client secret: our key's kid, signed by our key, about our team and app
      expect(decodeProtectedHeader(form.client_secret)).toEqual({
        alg: 'ES256',
        kid: 'KEY1234567',
      });
      const { payload } = await jwtVerify(
        form.client_secret,
        ourKeyPublicHalf,
        {
          issuer: 'TEAM123456',
          audience: APPLE_ISSUER,
          subject: 'com.inventra.app',
        },
      );
      expect(payload.exp! - payload.iat!).toBe(300);
    });

    it("a code for a DIFFERENT Apple user → that user's grant is not kept", async () => {
      fetchMock.mockResolvedValue(
        respond(200, await tokenAnswer('someone-else')),
      );

      await expect(
        verifier.verify(
          {
            identityToken: await appleIdentityToken(),
            authorizationCode: 'c-another-users-code',
          },
          rawNonce,
        ),
      ).resolves.toMatchObject({
        providerUserId: appleUserId,
        refreshToken: null,
      });
    });

    it('invalid_grant (code expired or used) → sign-in still works, refreshToken null', async () => {
      fetchMock.mockResolvedValue(respond(400, { error: 'invalid_grant' }));

      await expect(
        verifier.verify(
          {
            identityToken: await appleIdentityToken(),
            authorizationCode: 'c-apple-code',
          },
          rawNonce,
        ),
      ).resolves.toMatchObject({
        providerUserId: appleUserId,
        refreshToken: null,
      });
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('a broken .p8 key → sign-in still works, no call to Apple, warning logged', async () => {
      const broken = new AppleVerifier(
        { ...settings, privateKeyPem: 'not a key' },
        appleKeys.keySet,
      );

      await expect(
        broken.verify(
          {
            identityToken: await appleIdentityToken(),
            authorizationCode: 'c-apple-code',
          },
          rawNonce,
        ),
      ).resolves.toMatchObject({
        providerUserId: appleUserId,
        refreshToken: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('client secret failed'),
      );
    });
  });

  describe('disconnect', () => {
    it('revokes the refresh token, authenticated by a fresh client secret', async () => {
      fetchMock.mockResolvedValue(respond(200, {}));

      await verifier.disconnect({
        providerUserId: appleUserId,
        refreshToken: 'r-apple',
      });

      expect(fetchMock.mock.calls[0][0]).toBe(APPLE_REVOKE_URL);
      const form = sentForm(0);
      expect(form).toMatchObject({
        client_id: 'com.inventra.app',
        token: 'r-apple',
        token_type_hint: 'refresh_token',
      });
      await expect(
        jwtVerify(form.client_secret, ourKeyPublicHalf, {
          issuer: 'TEAM123456',
          audience: APPLE_ISSUER,
        }),
      ).resolves.toBeDefined();
    });

    it('no stored refresh token → nothing to revoke, no call', async () => {
      await verifier.disconnect({
        providerUserId: appleUserId,
        refreshToken: null,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an Apple error is thrown (the caller logs it: best-effort)', async () => {
      fetchMock.mockResolvedValue(respond(400, { error: 'invalid_client' }));

      await expect(
        verifier.disconnect({
          providerUserId: appleUserId,
          refreshToken: 'r-apple',
        }),
      ).rejects.toThrow('Apple revoke responded 400');
    });
  });
});
