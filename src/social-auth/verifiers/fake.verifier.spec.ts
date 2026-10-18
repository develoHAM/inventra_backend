import { UnauthorizedException } from '@nestjs/common';
import { FakeSocialVerifier } from './fake.verifier';
import type { SocialIdentity } from './social-identity-verifier';

describe('FakeSocialVerifier', () => {
  let fake: FakeSocialVerifier;

  const kakaoIdentity: SocialIdentity = {
    provider: 'kakao',
    providerUserId: 'kakao-user-1',
    email: 'owner@example.com',
    emailVerified: true,
    name: '김사장',
    refreshToken: null,
  };

  beforeEach(() => {
    fake = new FakeSocialVerifier();
  });

  it('a registered token proves its identity on its own provider', async () => {
    fake.register('kakao-token-1', kakaoIdentity);

    await expect(
      fake.forProvider('kakao').verify({ token: 'kakao-token-1' }),
    ).resolves.toEqual(kakaoIdentity);
  });

  it('returns a copy: the caller cannot change what later sign-ins get', async () => {
    fake.register('kakao-token-1', kakaoIdentity);
    const kakao = fake.forProvider('kakao');

    const first = await kakao.verify({ token: 'kakao-token-1' });
    first.email = 'changed@example.com';

    await expect(
      kakao.verify({ token: 'kakao-token-1' }),
    ).resolves.toMatchObject({ email: 'owner@example.com' });
  });

  it("another provider's token → 401 (a Kakao token on the Google route)", async () => {
    fake.register('kakao-token-1', kakaoIdentity);

    await expect(
      fake.forProvider('google').verify({ token: 'kakao-token-1' }),
    ).rejects.toThrow(new UnauthorizedException('Invalid social credential'));
  });

  it.each([
    ['an unknown token', { token: 'never-registered' }],
    ['no token', {}],
    ['a non-string token', { token: 12345 }],
  ])('%s → 401', async (_label, credential) => {
    await expect(
      fake.forProvider('kakao').verify(credential),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('disconnect records which provider was asked to forget whom', async () => {
    await fake.forProvider('apple').disconnect({
      providerUserId: 'apple-user-1',
      refreshToken: 'apple-refresh',
    });
    await fake
      .forProvider('kakao')
      .disconnect({ providerUserId: 'kakao-user-1', refreshToken: null });

    expect(fake.disconnected).toEqual([
      {
        provider: 'apple',
        providerUserId: 'apple-user-1',
        refreshToken: 'apple-refresh',
      },
      { provider: 'kakao', providerUserId: 'kakao-user-1', refreshToken: null },
    ]);
  });
});
