import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { Env } from '../config/env.schema';
import { SOCIAL_VERIFIERS } from './social-auth.constants';
import { SocialNonceService } from './social-nonce.service';
import { AppleVerifier } from './verifiers/apple.verifier';
import { FacebookVerifier } from './verifiers/facebook.verifier';
import { FakeSocialVerifier } from './verifiers/fake.verifier';
import { GoogleVerifier } from './verifiers/google.verifier';
import { KakaoVerifier } from './verifiers/kakao.verifier';
import type {
  SocialIdentityVerifier,
  SocialProvider,
} from './verifiers/social-identity-verifier';

/** Which verifier answers for each provider in this environment, chosen once at startup. */
export function buildSocialVerifiers(
  config: ConfigService<Env, true>,
  fake: FakeSocialVerifier,
): Record<SocialProvider, SocialIdentityVerifier> {
  if (config.get('SOCIAL_VERIFIER', { infer: true }) === 'fake') {
    return {
      kakao: fake.forProvider('kakao'),
      google: fake.forProvider('google'),
      facebook: fake.forProvider('facebook'),
      apple: fake.forProvider('apple'),
    };
  }

  // real: env validation guarantees every value below is set (hence the `!`)
  const setting = <Key extends keyof Env>(key: Key) =>
    config.get(key, { infer: true })!;
  const googleClientIds = setting('GOOGLE_CLIENT_IDS')
    .split(',')
    .map((clientId) => clientId.trim())
    .filter((clientId) => clientId.length > 0);

  return {
    kakao: new KakaoVerifier({
      nativeAppKey: setting('KAKAO_NATIVE_APP_KEY'),
      adminKey: setting('KAKAO_ADMIN_KEY'),
    }),
    google: new GoogleVerifier({
      audiences: googleClientIds,
      webClientId: googleClientIds[0], // by convention, the first is the web client
      clientSecret: setting('GOOGLE_CLIENT_SECRET'),
    }),
    apple: new AppleVerifier({
      teamId: setting('APPLE_TEAM_ID'),
      keyId: setting('APPLE_KEY_ID'),
      // read at startup: a missing key file stops the app now, not at the first sign-in
      privateKeyPem: readFileSync(setting('APPLE_PRIVATE_KEY_PATH'), 'utf8'),
      bundleId: setting('APPLE_BUNDLE_ID'),
    }),
    facebook: new FacebookVerifier({
      appId: setting('FACEBOOK_APP_ID'),
      appSecret: setting('FACEBOOK_APP_SECRET'),
    }),
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
