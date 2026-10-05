import { validateEnv } from './env.schema';

describe('validateEnv — phone verifier and push sender rules', () => {
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
});
