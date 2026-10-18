import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { SOCIAL_VERIFIERS } from './social-auth.constants';
import { SocialNonceService } from './social-nonce.service';
import { FakeSocialVerifier } from './verifiers/fake.verifier';
import type {
  SocialIdentityVerifier,
  SocialProvider,
} from './verifiers/social-identity-verifier';

/** Which verifier answers for each provider in this environment, chosen once at startup. */
export function buildSocialVerifiers(
  config: ConfigService<Env, true>,
  fake: FakeSocialVerifier,
): Record<SocialProvider, SocialIdentityVerifier> {
  if (config.get('SOCIAL_VERIFIER', { infer: true }) === 'real') {
    // Tasks 7–10 build the Kakao, Google, Apple and Facebook verifiers here.
    throw new Error(
      'SOCIAL_VERIFIER=real: the provider verifiers are not built yet',
    );
  }
  return {
    kakao: fake.forProvider('kakao'),
    google: fake.forProvider('google'),
    facebook: fake.forProvider('facebook'),
    apple: fake.forProvider('apple'),
  };
}

@Module({
  providers: [
    SocialNonceService,
    FakeSocialVerifier,
    {
      provide: SOCIAL_VERIFIERS,
      inject: [ConfigService, FakeSocialVerifier],
      useFactory: buildSocialVerifiers,
    },
  ],
})
export class SocialAuthModule {}
