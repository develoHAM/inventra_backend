import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderDisconnectService } from './provider-disconnect.service';
import { encryptToken } from '../common/token-cipher';
import type { Env } from '../config/env.schema';

/**
 * Asking a social provider to forget us: after an unlink, and for each
 * login of a deleted account. The login is already gone on our side, so
 * this never throws.
 */
describe('ProviderDisconnectService', () => {
  let service: ProviderDisconnectService;
  let verifiers: Record<string, { verify: jest.Mock; disconnect: jest.Mock }>;
  let config: { get: jest.Mock };
  let warn: jest.SpyInstance;

  const encryptionKey = Buffer.alloc(32, 7).toString('base64');
  // as the row is stored: the refresh token encrypted
  const googleLogin = {
    id: 'lm-google',
    method: 'google',
    providerUserId: '109876543210',
    refreshToken: encryptToken('1//google-refresh', encryptionKey),
  };

  beforeEach(() => {
    const verifierStub = () => ({
      verify: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined),
    });
    verifiers = {
      kakao: verifierStub(),
      google: verifierStub(),
      apple: verifierStub(),
      facebook: verifierStub(),
    };
    config = { get: jest.fn().mockReturnValue(encryptionKey) };
    service = new ProviderDisconnectService(
      verifiers,
      config as unknown as ConfigService<Env, true>,
    );
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('decrypts with the same key the link encrypted with', () => {
    expect(config.get).toHaveBeenCalledWith('LOGIN_TOKEN_ENCRYPTION_KEY', {
      infer: true,
    });
  });

  it("asks the login's own provider to forget us, with the DECRYPTED refresh token", async () => {
    await service.disconnectQuietly(googleLogin);

    expect(verifiers.google.disconnect).toHaveBeenCalledWith({
      providerUserId: '109876543210',
      refreshToken: '1//google-refresh',
    });
    for (const provider of ['kakao', 'apple', 'facebook']) {
      expect(verifiers[provider].disconnect).not.toHaveBeenCalled();
    }
  });

  it('a login stored without a refresh token (Kakao) → null', async () => {
    await service.disconnectQuietly({
      id: 'lm-kakao',
      method: 'kakao',
      providerUserId: '4321',
      refreshToken: null,
    });

    expect(verifiers.kakao.disconnect).toHaveBeenCalledWith({
      providerUserId: '4321',
      refreshToken: null,
    });
  });

  it('a password login has no provider to tell', async () => {
    await service.disconnectQuietly({
      id: 'lm-local',
      method: 'local',
      providerUserId: null,
      refreshToken: null,
    });

    for (const verifier of Object.values(verifiers)) {
      expect(verifier.disconnect).not.toHaveBeenCalled();
    }
  });

  it('the provider fails → resolves anyway; a warning names the provider and the login', async () => {
    verifiers.google.disconnect.mockRejectedValue(
      new Error('Google revoke responded 400'),
    );

    await expect(
      service.disconnectQuietly(googleLogin),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Could not disconnect google login lm-google: Google revoke responded 400',
    );
  });

  it('the stored token cannot be decrypted → resolves anyway, warned, the provider never called', async () => {
    await expect(
      service.disconnectQuietly({
        ...googleLogin,
        refreshToken: 'not-our-ciphertext',
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not disconnect google login lm-google'),
    );
    expect(verifiers.google.disconnect).not.toHaveBeenCalled();
  });
});
