import { Logger } from '@nestjs/common';
import { exchangeCodeForRefreshToken } from './code-exchange';
import { fakeProviderKeys } from '../../../test/helpers/provider-keys';

describe('exchangeCodeForRefreshToken', () => {
  let providerKeys: Awaited<ReturnType<typeof fakeProviderKeys>>;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status: status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  });
  const exchange = {
    provider: 'Apple',
    tokenUrl: 'https://provider.example/token',
    form: { grant_type: 'authorization_code', code: 'one-time-code' },
    expectedSub: 'user-1',
  };

  beforeAll(async () => {
    providerKeys = await fakeProviderKeys();
  });

  beforeEach(async () => {
    fetchMock = jest.fn().mockResolvedValue(
      respond(200, {
        refresh_token: 'refresh-1',
        id_token: await providerKeys.sign({ sub: 'user-1' }),
      }),
    );
    global.fetch = fetchMock;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POSTs the form, url-encoded, with a timeout', async () => {
    await exchangeCodeForRefreshToken(exchange);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://provider.example/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(init.body).toBe('grant_type=authorization_code&code=one-time-code');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the refresh token when the exchange names the same user', async () => {
    await expect(exchangeCodeForRefreshToken(exchange)).resolves.toBe(
      'refresh-1',
    );
  });

  it('no refresh_token in the answer → null, quietly (a normal outcome)', async () => {
    fetchMock.mockResolvedValue(respond(200, { access_token: 'a' }));

    await expect(exchangeCodeForRefreshToken(exchange)).resolves.toBeNull();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'names a different user',
      async () => ({
        refresh_token: 'refresh-1',
        id_token: await providerKeys.sign({ sub: 'someone-else' }),
      }),
    ],
    [
      'has no id_token, so the user cannot be confirmed',
      () => Promise.resolve({ refresh_token: 'refresh-1' }),
    ],
  ])('an answer that %s → null + warning', async (_label, answer) => {
    fetchMock.mockResolvedValue(respond(200, await answer()));

    await expect(exchangeCodeForRefreshToken(exchange)).resolves.toBeNull();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('Apple refresh token not obtained'),
    );
  });

  it.each([
    [
      'an error status',
      () =>
        fetchMock.mockResolvedValue(respond(400, { error: 'invalid_grant' })),
    ],
    [
      'a network failure',
      () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
    ],
  ])('%s → null + warning, never a throw', async (_label, fail) => {
    fail();

    await expect(exchangeCodeForRefreshToken(exchange)).resolves.toBeNull();
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });
});
