import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SignJWT, errors } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { checkNonce, claimIsTrue, verifyIdToken } from './id-token';
import { nonceClaimFor } from '../social-nonce.service';
import { fakeProviderKeys } from '../../../test/helpers/provider-keys';

describe('verifyIdToken', () => {
  let provider: Awaited<ReturnType<typeof fakeProviderKeys>>;

  const expected = {
    provider: 'Kakao',
    issuer: 'https://kauth.kakao.com',
    audience: 'our-native-app-key',
  };
  const validClaims = {
    iss: 'https://kauth.kakao.com',
    aud: 'our-native-app-key',
    sub: '4012345678',
  };
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    provider = await fakeProviderKeys();
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the claims of a token signed by the provider, for us, unexpired', async () => {
    const idToken = await provider.sign({ ...validClaims, email: 'a@b.com' });

    await expect(
      verifyIdToken(idToken, provider.keySet, expected),
    ).resolves.toMatchObject({ sub: '4012345678', email: 'a@b.com' });
  });

  it('accepts any of several audiences (Google: one client id per platform)', async () => {
    const idToken = await provider.sign({ ...validClaims, aud: 'ios-client' });

    await expect(
      verifyIdToken(idToken, provider.keySet, {
        ...expected,
        audience: ['web-client', 'ios-client'],
      }),
    ).resolves.toMatchObject({ sub: '4012345678' });
  });

  describe('a bad token → 401', () => {
    it.each([
      ['issued for ANOTHER app (wrong aud)', { aud: 'someone-elses-app' }],
      ['issued by someone else (wrong iss)', { iss: 'https://evil.example' }],
      ['expired', { exp: nowSeconds() - 60 }],
      ['without a subject', { sub: undefined }],
    ])('%s', async (_label, override) => {
      const idToken = await provider.sign({ ...validClaims, ...override });

      await expect(
        verifyIdToken(idToken, provider.keySet, expected),
      ).rejects.toThrow(new UnauthorizedException('Invalid social credential'));
    });

    it('signed by a different key claiming the provider’s kid (forged)', async () => {
      const forger = await fakeProviderKeys('test-key-1'); // same kid, other key
      const idToken = await forger.sign(validClaims);

      await expect(
        verifyIdToken(idToken, provider.keySet, expected),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('signed with a key id the provider never published', async () => {
      const idToken = await provider.sign(validClaims, { kid: 'unknown-kid' });

      await expect(
        verifyIdToken(idToken, provider.keySet, expected),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('HS256 with a guessed secret (algorithm confusion) is refused', async () => {
      const idToken = await new SignJWT(validClaims)
        .setProtectedHeader({ alg: 'HS256', kid: 'test-key-1' })
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('a-secret-anyone-could-pick-32b!!'));

      await expect(
        verifyIdToken(idToken, provider.keySet, expected),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([
      ['not a JWT at all', 'not-a-jwt'],
      ['empty', ''],
      ['missing', undefined],
      ['not a string', 12345],
    ])('%s', async (_label, idToken) => {
      await expect(
        verifyIdToken(idToken, provider.keySet, expected),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("the provider's keys can't be fetched → 503 (the token may be fine)", () => {
    it.each([
      ['network failure', new TypeError('fetch failed')],
      ['timeout', new errors.JWKSTimeout()],
      [
        'non-200 from the key server',
        new errors.JOSEError(
          'Expected 200 OK from the JSON Web Key Set HTTP response',
        ),
      ],
    ])('%s', async (_label, failure) => {
      const unreachableKeys: JWTVerifyGetKey = () => Promise.reject(failure);
      const idToken = await provider.sign(validClaims);

      await expect(
        verifyIdToken(idToken, unreachableKeys, expected),
      ).rejects.toThrow(
        new ServiceUnavailableException(
          'Kakao could not be reached; try again',
        ),
      );
    });
  });
});

describe('checkNonce', () => {
  const rawNonce = 'raw-nonce-from-our-server';
  const boundPayload = { nonce: nonceClaimFor(rawNonce) };

  it('passes when the token carries SHA-256(the nonce the app sent)', () => {
    expect(() =>
      checkNonce(boundPayload, rawNonce, { required: true }),
    ).not.toThrow();
  });

  it.each([
    ['a different nonce', 'some-other-nonce'],
    ['no nonce from the app', undefined],
  ])('token bound to a nonce, app sent %s → 401', (_label, sent) => {
    expect(() => checkNonce(boundPayload, sent, { required: false })).toThrow(
      UnauthorizedException,
    );
  });

  it('the RAW nonce in the token does not count (the token carries the hash)', () => {
    expect(() =>
      checkNonce({ nonce: rawNonce }, rawNonce, { required: true }),
    ).toThrow(UnauthorizedException);
  });

  it('required, but the token has none → 401', () => {
    expect(() => checkNonce({}, rawNonce, { required: true })).toThrow(
      UnauthorizedException,
    );
  });

  it('optional (Google) and the token has none → passes', () => {
    expect(() => checkNonce({}, undefined, { required: false })).not.toThrow();
  });
});

describe('claimIsTrue', () => {
  it.each([
    [true, true],
    ['true', true], // Apple sends email_verified as a string
    [false, false],
    ['false', false],
    [undefined, false],
    [1, false],
  ])('%p → %p', (value, expected) => {
    expect(claimIsTrue(value)).toBe(expected);
  });
});
