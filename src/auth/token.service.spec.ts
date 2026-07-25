import { Test } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({})], // a REAL JwtService
      providers: [
        TokenService,
        { provide: ConfigService, useValue: mockConfig }, // a MOCK ConfigService
      ],
    }).compile();

    tokenService = moduleRef.get(TokenService);
  });

  it('signs an access token that verifies', async () => {
    const token = await tokenService.signAccess('user-123');
    const payload = await tokenService.verifyAccess(token);
    expect(payload.sub).toBe('user-123');
  });

  it('rejects a refresh token when verified as an access token', async () => {
    // NOTE: signRefresh returns an object — destructure the token string out of it
    const { token } = await tokenService.signRefresh('user-123');
    // signed with the REFRESH secret → access verification (different secret) fails
    await expect(tokenService.verifyAccess(token)).rejects.toThrow();
  });

  it('verifyRefresh returns sub and jti', async () => {
    const { token } = await tokenService.signRefresh('user-123');
    const payload = await tokenService.verifyRefresh(token);
    expect(payload.sub).toBe('user-123');
    expect(payload).toHaveProperty('jti');
  });

  it('returns a jti that matches the jti embedded in the token', async () => {
    const { token, jti } = await tokenService.signRefresh('user-123');
    const payload = await tokenService.verifyRefresh(token);
    expect(payload.jti).toBe(jti);
  });

  it('returns an expiresAt Date in the future', async () => {
    const { expiresAt } = await tokenService.signRefresh('user-123');
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
