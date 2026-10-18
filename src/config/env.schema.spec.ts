import { validateEnv } from './env.schema';

describe('validateEnv — provider selection and secrets', () => {
  // A complete, valid environment; each test changes only what it's about.
  const baseEnv = {
    NODE_ENV: 'test',
    REDIS_PASSWORD: 'redis-password',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/inventra_test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    SEED_ADMIN_EMAIL: 'admin@example.com',
    SEED_ADMIN_PASSWORD: 'password123',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minio',
    S3_SECRET_KEY: 'minio-secret',
    S3_BUCKET: 'inventra-files-test',
    PHONE_VERIFIER: 'fake',
    PUSH_SENDER: 'fake',
    SOCIAL_VERIFIER: 'fake',
    LOGIN_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    VERIFICATION_CODE_SECRET: 'v'.repeat(32),
  };

  it('accepts the fake verifier outside production', () => {
    const env = validateEnv({ ...baseEnv });

    expect(env.PHONE_VERIFIER).toBe('fake');
  });

  it('accepts octomo when an API key is set', () => {
    const env = validateEnv({
      ...baseEnv,
      PHONE_VERIFIER: 'octomo',
      OCTOMO_API_KEY: 'live-key',
    });

    expect(env.PHONE_VERIFIER).toBe('octomo');
    expect(env.OCTOMO_API_KEY).toBe('live-key');
  });

  it('rejects octomo without an API key, naming the missing variable', () => {
    expect(() => validateEnv({ ...baseEnv, PHONE_VERIFIER: 'octomo' })).toThrow(
      /OCTOMO_API_KEY/,
    );
  });

  it('rejects the fake verifier in production', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production' })).toThrow(
      /PHONE_VERIFIER/,
    );
  });

  it('rejects an unknown verifier name', () => {
    expect(() => validateEnv({ ...baseEnv, PHONE_VERIFIER: 'twilio' })).toThrow(
      /PHONE_VERIFIER/,
    );
  });

  it('requires PHONE_VERIFIER to be set at all', () => {
    const { PHONE_VERIFIER: _omitted, ...withoutVerifier } = baseEnv;

    expect(() => validateEnv(withoutVerifier)).toThrow(/PHONE_VERIFIER/);
  });

  it('accepts fcm when the service-account path is set', () => {
    const env = validateEnv({
      ...baseEnv,
      PUSH_SENDER: 'fcm',
      FIREBASE_SERVICE_ACCOUNT_PATH: '/secrets/firebase.json',
    });

    expect(env.PUSH_SENDER).toBe('fcm');
  });

  it('rejects fcm without a service-account path', () => {
    expect(() => validateEnv({ ...baseEnv, PUSH_SENDER: 'fcm' })).toThrow(
      /FIREBASE_SERVICE_ACCOUNT_PATH/,
    );
  });

  it('rejects the fake push sender in production', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        PHONE_VERIFIER: 'octomo',
        OCTOMO_API_KEY: 'live-key',
      }),
    ).toThrow(/PUSH_SENDER/);
  });

  it('requires PUSH_SENDER to be set at all', () => {
    const { PUSH_SENDER: _omitted, ...withoutPush } = baseEnv;

    expect(() => validateEnv(withoutPush)).toThrow(/PUSH_SENDER/);
  });

  it('accepts a 32-byte base64 encryption key', () => {
    expect(() => validateEnv({ ...baseEnv })).not.toThrow();
  });

  it.each([
    ['16 bytes', Buffer.alloc(16, 1).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64')],
    ['empty', ''],
  ])('rejects an encryption key of %s', (_label, key) => {
    expect(() =>
      validateEnv({ ...baseEnv, LOGIN_TOKEN_ENCRYPTION_KEY: key }),
    ).toThrow(/LOGIN_TOKEN_ENCRYPTION_KEY/);
  });

  it('requires a verification-code secret of at least 32 characters', () => {
    expect(() =>
      validateEnv({ ...baseEnv, VERIFICATION_CODE_SECRET: 'short' }),
    ).toThrow(/VERIFICATION_CODE_SECRET/);
  });

  describe('SOCIAL_VERIFIER', () => {
    // Everything the real Kakao, Google, Apple and Facebook verifiers need.
    const socialCredentials = {
      KAKAO_NATIVE_APP_KEY: 'kakao-native-app-key',
      KAKAO_ADMIN_KEY: 'kakao-admin-key',
      GOOGLE_CLIENT_IDS:
        'web.apps.googleusercontent.com,ios.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_KEY_ID: 'KEY1234567',
      APPLE_PRIVATE_KEY_PATH: '/secrets/AuthKey_KEY1234567.p8',
      APPLE_BUNDLE_ID: 'com.inventra.app',
      FACEBOOK_APP_ID: '1234567890',
      FACEBOOK_APP_SECRET: 'facebook-app-secret',
    };

    it('accepts fake outside production, with no provider credentials', () => {
      expect(validateEnv({ ...baseEnv }).SOCIAL_VERIFIER).toBe('fake');
    });

    it('is required', () => {
      const { SOCIAL_VERIFIER: _omitted, ...withoutSocial } = baseEnv;

      expect(() => validateEnv(withoutSocial)).toThrow(/SOCIAL_VERIFIER/);
    });

    it('rejects an unknown value', () => {
      expect(() =>
        validateEnv({ ...baseEnv, SOCIAL_VERIFIER: 'supabase' }),
      ).toThrow(/SOCIAL_VERIFIER/);
    });

    it('rejects fake in production', () => {
      expect(() =>
        validateEnv({
          ...baseEnv,
          NODE_ENV: 'production',
          PHONE_VERIFIER: 'octomo',
          OCTOMO_API_KEY: 'live-key',
          PUSH_SENDER: 'fcm',
          FIREBASE_SERVICE_ACCOUNT_PATH: '/secrets/firebase.json',
        }),
      ).toThrow(/SOCIAL_VERIFIER: fake is not allowed in production/);
    });

    it('accepts real when every provider credential is set', () => {
      const env = validateEnv({
        ...baseEnv,
        SOCIAL_VERIFIER: 'real',
        ...socialCredentials,
      });

      expect(env.SOCIAL_VERIFIER).toBe('real');
      expect(env.APPLE_BUNDLE_ID).toBe('com.inventra.app');
    });

    it.each(Object.keys(socialCredentials))(
      'real without %s is rejected, naming it',
      (missing) => {
        const credentials: Record<string, string> = { ...socialCredentials };
        delete credentials[missing];

        expect(() =>
          validateEnv({ ...baseEnv, SOCIAL_VERIFIER: 'real', ...credentials }),
        ).toThrow(new RegExp(`${missing}: required when SOCIAL_VERIFIER=real`));
      },
    );

    it('real with no credentials lists all ten at once (one fix, not ten restarts)', () => {
      let message = '';
      try {
        validateEnv({ ...baseEnv, SOCIAL_VERIFIER: 'real' });
      } catch (caught) {
        message = (caught as Error).message;
      }

      for (const name of Object.keys(socialCredentials)) {
        expect(message).toContain(
          `${name}: required when SOCIAL_VERIFIER=real`,
        );
      }
    });
  });
});
