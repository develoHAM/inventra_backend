import { UnauthorizedException } from '@nestjs/common';
import { buildSocialVerifiers } from './social-auth.module';
import { FakeSocialVerifier } from './verifiers/fake.verifier';
import { SOCIAL_PROVIDERS } from './verifiers/social-identity-verifier';

describe('buildSocialVerifiers', () => {
  const configWith = (socialVerifier: 'real' | 'fake') =>
    ({ get: jest.fn().mockReturnValue(socialVerifier) }) as any;

  it('fake: every provider gets a verifier', () => {
    const verifiers = buildSocialVerifiers(
      configWith('fake'),
      new FakeSocialVerifier(),
    );

    expect(Object.keys(verifiers).sort()).toEqual([...SOCIAL_PROVIDERS].sort());
  });

  it('fake: each verifier speaks for its own provider only', async () => {
    const fake = new FakeSocialVerifier();
    fake.register('google-token-1', {
      provider: 'google',
      providerUserId: 'google-user-1',
      email: null,
      emailVerified: false,
      name: null,
      refreshToken: null,
    });
    const verifiers = buildSocialVerifiers(configWith('fake'), fake);

    await expect(
      verifiers.google.verify({ token: 'google-token-1' }),
    ).resolves.toMatchObject({ providerUserId: 'google-user-1' });
    await expect(
      verifiers.apple.verify({ token: 'google-token-1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('real: refuses to start until Tasks 7–10 add the provider verifiers', () => {
    expect(() =>
      buildSocialVerifiers(configWith('real'), new FakeSocialVerifier()),
    ).toThrow(/not built yet/);
  });
});
