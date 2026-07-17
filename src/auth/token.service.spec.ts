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
  let userId = 1;
  let testToken1 = 'testToken1';
  let testToken2 = 'testToken2';

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

  // TODO (you): type isolation, verifyRefresh returns sub+jti, hashToken determinism

  it('can sign a refresh token and detect wrong tokens', async () => {
    const token = await tokenService.signRefresh(userId.toString());

    await expect(tokenService.verifyAccess(token)).rejects.toThrow();
  });

  it('guarantees refresh token has both sub and a jti', async () => {
    const token = await tokenService.signRefresh(userId.toString());

    const verifiedToken = await tokenService.verifyRefresh(token);

    expect(verifiedToken).toHaveProperty('sub');
    expect(verifiedToken).toHaveProperty('jti');
  });

  it('hashes to the same value for the same input', () => {
    const hash1 = tokenService.hashToken(testToken1);
    const hash2 = tokenService.hashToken(testToken1);
    const hash3 = tokenService.hashToken(testToken2);

    expect(hash1).toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).not.toBe(hash3);
  });
});
