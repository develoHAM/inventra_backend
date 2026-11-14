import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';

const mockConfig = {
  get: (key: string) =>
    ({
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
    })[key],
};

describe('TokenService', () => {
  let tokenService: TokenService;
  let jwt: JwtService; // to read a token's payload without verifying it

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({})], // a REAL JwtService
      providers: [
        TokenService,
        { provide: ConfigService, useValue: mockConfig }, // a MOCK ConfigService
      ],
    }).compile();

    tokenService = moduleRef.get(TokenService);
    jwt = moduleRef.get(JwtService);
  });

  describe('access tokens name the account and, when one is open, the profile', () => {
    it('signs { sub: accountId, pid: profileId, type: access }', async () => {
      const token = await tokenService.signAccess({
        accountId: 'account-1',
        profileId: 'profile-1',
      });

      expect(jwt.decode(token)).toMatchObject({
        sub: 'account-1',
        pid: 'profile-1',
        type: 'access',
      });
    });

    it('verifies back to { accountId, profileId }', async () => {
      const token = await tokenService.signAccess({
        accountId: 'account-1',
        profileId: 'profile-1',
      });

      await expect(tokenService.verifyAccess(token)).resolves.toEqual({
        accountId: 'account-1',
        profileId: 'profile-1',
      });
    });

    it('no profile open → the token carries no pid at all, and verifies to profileId null', async () => {
      const token = await tokenService.signAccess({
        accountId: 'account-1',
        profileId: null,
      });

      expect(jwt.decode(token)).not.toHaveProperty('pid');
      await expect(tokenService.verifyAccess(token)).resolves.toEqual({
        accountId: 'account-1',
        profileId: null,
      });
    });
  });

  it('rejects a refresh token when verified as an access token', async () => {
    // NOTE: signRefresh returns an object — destructure the token string out of it
    const { token } = await tokenService.signRefresh('account-1');
    // signed with the REFRESH secret → access verification (different secret) fails
    await expect(tokenService.verifyAccess(token)).rejects.toThrow();
  });

  it('a refresh token names only the account (the session row remembers the profile)', async () => {
    const { token } = await tokenService.signRefresh('account-1');

    const payload = jwt.decode<Record<string, unknown>>(token);
    expect(payload).toMatchObject({ sub: 'account-1', type: 'refresh' });
    expect(payload).not.toHaveProperty('pid');
  });

  it('verifyRefresh returns accountId and jti', async () => {
    const { token } = await tokenService.signRefresh('account-1');
    const payload = await tokenService.verifyRefresh(token);
    expect(payload.accountId).toBe('account-1');
    expect(payload).toHaveProperty('jti');
  });

  it('returns a jti that matches the jti embedded in the token', async () => {
    const { token, jti } = await tokenService.signRefresh('account-1');
    const payload = await tokenService.verifyRefresh(token);
    expect(payload.jti).toBe(jti);
  });

  it('returns an expiresAt Date in the future', async () => {
    const { expiresAt } = await tokenService.signRefresh('account-1');
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('hashes to the same value for the same input', () => {
    const hash1 = tokenService.hashToken('token-a');
    const hash2 = tokenService.hashToken('token-a');
    const hash3 = tokenService.hashToken('token-b');

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });
});
