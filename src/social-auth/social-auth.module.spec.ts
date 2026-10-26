import { Module, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { SocialAuthController } from './social-auth.controller';
import { SocialAuthModule, buildSocialVerifiers } from './social-auth.module';
import { SocialAuthService } from './social-auth.service';
import { AppleVerifier } from './verifiers/apple.verifier';
import { FacebookVerifier } from './verifiers/facebook.verifier';
import { FakeSocialVerifier } from './verifiers/fake.verifier';
import { GoogleVerifier } from './verifiers/google.verifier';
import { KakaoVerifier } from './verifiers/kakao.verifier';
import { SOCIAL_PROVIDERS } from './verifiers/social-identity-verifier';

describe('buildSocialVerifiers', () => {
  /** A ConfigService stand-in that answers from a plain object. */
  const configFrom = (env: Record<string, string>) =>
    ({ get: jest.fn((key: string) => env[key]) }) as any;

  describe('fake', () => {
    it('every provider gets a verifier', () => {
      const verifiers = buildSocialVerifiers(
        configFrom({ SOCIAL_VERIFIER: 'fake' }),
        new FakeSocialVerifier(),
      );

      expect(Object.keys(verifiers).sort()).toEqual(
        [...SOCIAL_PROVIDERS].sort(),
      );
    });

    it('each verifier speaks for its own provider only', async () => {
      const fake = new FakeSocialVerifier();
      fake.register('google-token-1', {
        provider: 'google',
        providerUserId: 'google-user-1',
        email: null,
        emailVerified: false,
        name: null,
        refreshToken: null,
      });
      const verifiers = buildSocialVerifiers(
        configFrom({ SOCIAL_VERIFIER: 'fake' }),
        fake,
      );

      await expect(
        verifiers.google.verify({ token: 'google-token-1' }),
      ).resolves.toMatchObject({ providerUserId: 'google-user-1' });
      await expect(
        verifiers.apple.verify({ token: 'google-token-1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('real', () => {
    let keyDirectory: string;
    let realEnv: Record<string, string>;

    beforeAll(() => {
      // the .p8 is only read here, not parsed: any text will do
      keyDirectory = mkdtempSync(join(tmpdir(), 'inventra-apple-key-'));
      const keyPath = join(keyDirectory, 'AuthKey_KEY1234567.p8');
      writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\ntest\n');
      realEnv = {
        SOCIAL_VERIFIER: 'real',
        KAKAO_NATIVE_APP_KEY: 'kakao-native-app-key',
        KAKAO_ADMIN_KEY: 'kakao-admin-key',
        GOOGLE_CLIENT_IDS:
          ' web.apps.googleusercontent.com , ios.apps.googleusercontent.com ,',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        APPLE_TEAM_ID: 'TEAM123456',
        APPLE_KEY_ID: 'KEY1234567',
        APPLE_PRIVATE_KEY_PATH: keyPath,
        APPLE_BUNDLE_ID: 'com.inventra.app',
        FACEBOOK_APP_ID: '1234567890',
        FACEBOOK_APP_SECRET: 'facebook-app-secret',
      };
    });

    afterAll(() => {
      rmSync(keyDirectory, { recursive: true, force: true });
    });

    it('builds the real verifier for each provider', () => {
      const verifiers = buildSocialVerifiers(
        configFrom(realEnv),
        new FakeSocialVerifier(),
      );

      expect(verifiers.kakao).toBeInstanceOf(KakaoVerifier);
      expect(verifiers.google).toBeInstanceOf(GoogleVerifier);
      expect(verifiers.apple).toBeInstanceOf(AppleVerifier);
      expect(verifiers.facebook).toBeInstanceOf(FacebookVerifier);
    });

    it('Google: every listed id is an audience; the FIRST is the web client', () => {
      const verifiers = buildSocialVerifiers(
        configFrom(realEnv),
        new FakeSocialVerifier(),
      );

      expect((verifiers.google as GoogleVerifier)['settings']).toEqual({
        audiences: [
          'web.apps.googleusercontent.com',
          'ios.apps.googleusercontent.com',
        ],
        webClientId: 'web.apps.googleusercontent.com',
        clientSecret: 'google-client-secret',
      });
    });

    it('Apple: the key file is read at startup', () => {
      const verifiers = buildSocialVerifiers(
        configFrom(realEnv),
        new FakeSocialVerifier(),
      );

      expect((verifiers.apple as AppleVerifier)['settings'].privateKeyPem).toBe(
        '-----BEGIN PRIVATE KEY-----\ntest\n',
      );
    });

    it('Apple: a missing key file stops startup (not the first sign-in)', () => {
      expect(() =>
        buildSocialVerifiers(
          configFrom({
            ...realEnv,
            APPLE_PRIVATE_KEY_PATH: join(keyDirectory, 'missing.p8'),
          }),
          new FakeSocialVerifier(),
        ),
      ).toThrow(/ENOENT/);
    });
  });
});

/** Stands in for NotificationsModule, whose BullMQ queue would reach for Redis. */
@Module({
  providers: [
    { provide: NotificationsService, useValue: { dispatch: jest.fn() } },
  ],
  exports: [NotificationsService],
})
class StubNotificationsModule {}

describe('SocialAuthModule wiring', () => {
  // Builds the REAL module graph (SocialAuthModule → AuthModule →
  // SignupTicketsModule, EmailVerificationModule, …) with only the database
  // and the notification queue swapped out: a missing export or a circular
  // import fails here instead of at app start.
  it('Nest can resolve every dependency of social sign-in and signup', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              SOCIAL_VERIFIER: 'fake',
              PHONE_VERIFIER: 'fake',
              PUSH_SENDER: 'fake',
              LOGIN_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString(
                'base64',
              ),
              VERIFICATION_CODE_SECRET: 'v'.repeat(32),
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        PrismaModule,
        SocialAuthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideModule(NotificationsModule)
      .useModule(StubNotificationsModule)
      .compile();

    expect(moduleRef.get(SocialAuthService)).toBeInstanceOf(SocialAuthService);
    expect(moduleRef.get(SocialAuthController)).toBeInstanceOf(
      SocialAuthController,
    );
    // AuthModule now spends signup tickets and email proofs (Task 12)
    expect(moduleRef.get(AuthService)).toBeInstanceOf(AuthService);
    await moduleRef.close();
  });
});
