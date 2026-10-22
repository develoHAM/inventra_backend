import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  FACEBOOK_GRAPH_URL,
  FACEBOOK_ISSUER,
  FacebookVerifier,
} from './facebook.verifier';
import { nonceClaimFor } from '../social-nonce.service';
import { fakeProviderKeys } from '../../../test/helpers/provider-keys';

describe('FacebookVerifier', () => {
  let facebookKeys: Awaited<ReturnType<typeof fakeProviderKeys>>;
  let verifier: FacebookVerifier;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  const settings = { appId: '1234567890', appSecret: 'facebook-app-secret' };
  const rawNonce = 'raw-nonce-from-our-server';
  const facebookUserId = '10229876543210';

  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status: status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  });

  /** Graph API answers, keyed by path; a test overrides one to make it fail. */
  let graphAnswers: Record<string, ReturnType<typeof respond>>;
  const validTokenInfo = {
    data: {
      app_id: '1234567890',
      type: 'USER',
      is_valid: true,
      user_id: facebookUserId,
    },
  };
  const me = {
    id: facebookUserId,
    name: 'Kim Owner',
    email: 'owner@example.com',
  };

  /** The URL of the Graph call to `path`, parsed. */
  const graphCall = (path: string) => {
    const call = fetchMock.mock.calls.find(([url]) =>
      new URL(url as string).pathname.startsWith(path),
    );
    return new URL(call![0] as string);
  };

  /** iOS Limited Login's authenticationToken: an OIDC ID token for our app. */
  const limitedLoginToken = (claims: Record<string, unknown> = {}) =>
    facebookKeys.sign({
      iss: FACEBOOK_ISSUER,
      aud: settings.appId,
      sub: facebookUserId,
      nonce: nonceClaimFor(rawNonce),
      name: 'Kim Owner',
      email: 'owner@example.com',
      ...claims,
    });

  beforeAll(async () => {
    facebookKeys = await fakeProviderKeys();
  });

  beforeEach(() => {
    graphAnswers = {
      '/debug_token': respond(200, validTokenInfo),
      '/me': respond(200, me),
    };
    fetchMock = jest.fn((url: string) =>
      Promise.resolve(graphAnswers[new URL(url).pathname]),
    );
    global.fetch = fetchMock;
    verifier = new FacebookVerifier(settings, facebookKeys.keySet);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('iOS: { authenticationToken } (Limited Login, an ID token)', () => {
    it('maps a valid token to the identity, with no Graph call', async () => {
      const credential = { authenticationToken: await limitedLoginToken() };

      await expect(verifier.verify(credential, rawNonce)).resolves.toEqual({
        provider: 'facebook',
        providerUserId: facebookUserId,
        email: 'owner@example.com',
        emailVerified: true, // Facebook shares an email only when it has a valid one
        name: 'Kim Owner',
        refreshToken: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no email permission → email null, unverified', async () => {
      const credential = {
        authenticationToken: await limitedLoginToken({ email: undefined }),
      };

      await expect(
        verifier.verify(credential, rawNonce),
      ).resolves.toMatchObject({
        email: null,
        emailVerified: false,
      });
    });

    it('a token for another Facebook app → 401', async () => {
      const credential = {
        authenticationToken: await limitedLoginToken({ aud: '999999' }),
      };

      await expect(
        verifier.verify(credential, rawNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([
      ['no nonce from the app', undefined],
      ['a different nonce', 'replayed-or-stolen'],
    ])('the nonce is required: %s → 401', async (_label, sentNonce) => {
      const credential = { authenticationToken: await limitedLoginToken() };

      await expect(
        verifier.verify(credential, sentNonce),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a non-string authenticationToken → 401 (not the Android path)', async () => {
      await expect(
        verifier.verify(
          { authenticationToken: 42, accessToken: 'EAAB' },
          rawNonce,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Android: { accessToken } (opaque, so Facebook checks it)', () => {
    it('asks debug_token with OUR app token, then /me with an appsecret_proof', async () => {
      await expect(
        verifier.verify({ accessToken: 'EAAB-user-token' }),
      ).resolves.toEqual({
        provider: 'facebook',
        providerUserId: facebookUserId,
        email: 'owner@example.com',
        emailVerified: true,
        name: 'Kim Owner',
        refreshToken: null,
      });

      const debugToken = graphCall('/debug_token');
      expect(debugToken.origin).toBe(FACEBOOK_GRAPH_URL);
      expect(debugToken.searchParams.get('input_token')).toBe(
        'EAAB-user-token',
      );
      expect(debugToken.searchParams.get('access_token')).toBe(
        '1234567890|facebook-app-secret',
      );

      const meCall = graphCall('/me');
      expect(meCall.searchParams.get('fields')).toBe('id,name,email');
      expect(meCall.searchParams.get('access_token')).toBe('EAAB-user-token');
      expect(meCall.searchParams.get('appsecret_proof')).toBe(
        createHmac('sha256', 'facebook-app-secret')
          .update('EAAB-user-token')
          .digest('hex'),
      );
    });

    it.each([
      ['invalid or expired', { ...validTokenInfo.data, is_valid: false }],
      ['issued for ANOTHER app', { ...validTokenInfo.data, app_id: '999999' }],
      ['without a user', { ...validTokenInfo.data, user_id: undefined }],
    ])(
      'a token Facebook calls %s → 401, /me never asked',
      async (_label, data) => {
        graphAnswers['/debug_token'] = respond(200, { data: data });

        await expect(
          verifier.verify({ accessToken: 'EAAB-user-token' }),
        ).rejects.toThrow(
          new UnauthorizedException('Invalid social credential'),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it('/me names a different user than debug_token → 401', async () => {
      graphAnswers['/me'] = respond(200, { ...me, id: 'someone-else' });

      await expect(
        verifier.verify({ accessToken: 'EAAB-user-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([
      [
        'debug_token answers 400 (e.g. our app secret is wrong)',
        '/debug_token',
      ],
      ['/me answers 500', '/me'],
    ])('%s → 503', async (_label, path) => {
      graphAnswers[path] = respond(path === '/me' ? 500 : 400, {
        error: { code: 190 },
      });

      await expect(
        verifier.verify({ accessToken: 'EAAB-user-token' }),
      ).rejects.toThrow(
        new ServiceUnavailableException(
          'Facebook could not be reached; try again',
        ),
      );
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('Facebook unreachable → 503', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        verifier.verify({ accessToken: 'EAAB-user-token' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  it('neither credential → 401', async () => {
    await expect(
      verifier.verify({ idToken: 'wrong-field' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('disconnect', () => {
    it("deletes the user's permissions with our app token (de-authorizes the app)", async () => {
      fetchMock.mockResolvedValue(respond(200, { success: true }));

      await verifier.disconnect({
        providerUserId: facebookUserId,
        refreshToken: null,
      });

      const [url, init] = fetchMock.mock.calls[0];
      const parsed = new URL(url as string);
      expect(parsed.origin + parsed.pathname).toBe(
        `${FACEBOOK_GRAPH_URL}/${facebookUserId}/permissions`,
      );
      expect(parsed.searchParams.get('access_token')).toBe(
        '1234567890|facebook-app-secret',
      );
      expect(init.method).toBe('DELETE');
    });

    it('a Facebook error is thrown (the caller logs it: best-effort)', async () => {
      fetchMock.mockResolvedValue(respond(400, { error: { code: 100 } }));

      await expect(
        verifier.disconnect({
          providerUserId: facebookUserId,
          refreshToken: null,
        }),
      ).rejects.toThrow('Facebook disconnect responded 400');
    });
  });
});
