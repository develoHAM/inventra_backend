import { Logger } from '@nestjs/common';
import { OctomoPhoneVerifier } from './octomo.verifier';
import { OCTOMO_EXISTS_URL } from '../phone-verification.constants';

describe('OctomoPhoneVerifier', () => {
  let verifier: OctomoPhoneVerifier;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  // a stand-in for the real Response object fetch() resolves with
  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status: status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  });

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(respond(200, { exists: true }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const config = { get: jest.fn().mockReturnValue('test-key') };
    verifier = new OctomoPhoneVerifier(config as any);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POSTs the phone, text and window to the exists endpoint with the API key', async () => {
    await verifier.messageExists('01012345678', '482913', 2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OCTOMO_EXISTS_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Octomo test-key',
    });
    expect(JSON.parse(init.body)).toEqual({
      mobileNum: '01012345678',
      text: '482913',
      withinMinutes: 2,
    });
  });

  it('passes an AbortSignal so a hanging provider times out', async () => {
    await verifier.messageExists('01012345678', '482913', 1);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns true when OCTOMO says exists: true', async () => {
    await expect(
      verifier.messageExists('01012345678', '482913', 1),
    ).resolves.toBe(true);
  });

  it('returns false when OCTOMO says exists: false', async () => {
    fetchMock.mockResolvedValue(respond(200, { exists: false }));

    await expect(
      verifier.messageExists('01012345678', '482913', 1),
    ).resolves.toBe(false);
  });

  it.each([
    ['missing', {}],
    ['a string', { exists: 'true' }],
    ['a number', { exists: 1 }],
  ])(
    'treats a %s exists field as false (only a real true counts)',
    async (_label, body) => {
      fetchMock.mockResolvedValue(respond(200, body));

      await expect(
        verifier.messageExists('01012345678', '482913', 1),
      ).resolves.toBe(false);
    },
  );

  it.each([400, 401, 403, 429, 500])(
    'throws on HTTP %i instead of answering false',
    async (status) => {
      fetchMock.mockResolvedValue(respond(status, { message: 'nope' }));

      await expect(
        verifier.messageExists('01012345678', '482913', 1),
      ).rejects.toThrow(`OCTOMO responded ${status}`);
    },
  );

  it("includes OCTOMO's own error message and logs it", async () => {
    fetchMock.mockResolvedValue(
      respond(429, { message: '월 API 호출 한도를 초과했습니다.' }),
    );

    await expect(
      verifier.messageExists('01012345678', '482913', 1),
    ).rejects.toThrow('월 API 호출 한도를 초과했습니다.');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('OCTOMO responded 429'),
      expect.any(String),
    );
  });

  it('rejects when the network call itself fails (e.g. timeout)', async () => {
    fetchMock.mockRejectedValue(
      new Error('The operation was aborted due to timeout'),
    );

    await expect(
      verifier.messageExists('01012345678', '482913', 1),
    ).rejects.toThrow('timeout');
  });
});
