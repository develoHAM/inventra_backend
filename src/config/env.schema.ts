import { z } from 'zod';

// Every provider credential the real verifiers need (all four providers ship together).
const SOCIAL_PROVIDER_ENV = [
  'KAKAO_NATIVE_APP_KEY',
  'KAKAO_ADMIN_KEY',
  'GOOGLE_CLIENT_IDS',
  'GOOGLE_CLIENT_SECRET',
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
  'APPLE_PRIVATE_KEY_PATH',
  'APPLE_BUNDLE_ID',
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
] as const;

export const envSchema = z
  .object({
    // -- App --
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    // -- Redis --
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PASSWORD: z.string().min(1),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    BULLMQ_PREFIX: z.string().default('inventra'),
    // -- Email (SMTP) --
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().default('Inventra <no-reply@inventra.local>'),
    // -- Phone verification (OCTOMO reverse SMS) --
    PHONE_VERIFIER: z.enum(['octomo', 'fake']),
    OCTOMO_API_KEY: z.string().min(1).optional(),
    // -- Push (FCM) --
    PUSH_SENDER: z.enum(['fcm', 'fake']),
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().min(1).optional(),
    // -- Social login (Kakao · Google · Facebook · Apple) --
    SOCIAL_VERIFIER: z.enum(['real', 'fake']),
    KAKAO_NATIVE_APP_KEY: z.string().min(1).optional(), // the id token's audience
    KAKAO_ADMIN_KEY: z.string().min(1).optional(), // unlinks a user from our app
    GOOGLE_CLIENT_IDS: z.string().min(1).optional(), // comma-separated audiences
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(), // exchanges serverAuthCode
    APPLE_TEAM_ID: z.string().min(1).optional(),
    APPLE_KEY_ID: z.string().min(1).optional(),
    APPLE_PRIVATE_KEY_PATH: z.string().min(1).optional(), // the .p8 key file
    APPLE_BUNDLE_ID: z.string().min(1).optional(), // the id token's audience
    FACEBOOK_APP_ID: z.string().min(1).optional(),
    FACEBOOK_APP_SECRET: z.string().min(1).optional(),
    // -- Account security secrets --
    // AES-256-GCM key for provider refresh tokens we must read back (Apple/Google)
    LOGIN_TOKEN_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'must be 32 bytes, base64-encoded (openssl rand -base64 32)',
      }),
    // HMAC key for emailed verification codes (a 6-digit code needs a keyed hash)
    VERIFICATION_CODE_SECRET: z.string().min(32),
    // -- Database --
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith('postgresql://') || v.startsWith('postgres://'),
        { message: 'must be a postgres connection string (postgresql://...)' },
      ),
    // -- Auth (JWT) --
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
    // -- Seed (initial platform admin) --
    SEED_ADMIN_EMAIL: z.email(),
    SEED_ADMIN_PASSWORD: z.string().min(8),
    // -- Storage (S3 / MinIO) --
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_PRESIGN_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),
  })
  // Rules that involve more than one field run after every field passed its own check.
  .superRefine((env, context) => {
    if (env.PHONE_VERIFIER === 'octomo' && !env.OCTOMO_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['OCTOMO_API_KEY'],
        message: 'required when PHONE_VERIFIER=octomo',
      });
    }
    if (env.NODE_ENV === 'production' && env.PHONE_VERIFIER === 'fake') {
      context.addIssue({
        code: 'custom',
        path: ['PHONE_VERIFIER'],
        message: 'fake is not allowed in production',
      });
    }
    if (env.PUSH_SENDER === 'fcm' && !env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      context.addIssue({
        code: 'custom',
        path: ['FIREBASE_SERVICE_ACCOUNT_PATH'],
        message: 'required when PUSH_SENDER=fcm',
      });
    }
    if (env.NODE_ENV === 'production' && env.PUSH_SENDER === 'fake') {
      context.addIssue({
        code: 'custom',
        path: ['PUSH_SENDER'],
        message: 'fake is not allowed in production',
      });
    }
    if (env.SOCIAL_VERIFIER === 'real') {
      for (const name of SOCIAL_PROVIDER_ENV) {
        if (!env[name]) {
          context.addIssue({
            code: 'custom',
            path: [name],
            message: 'required when SOCIAL_VERIFIER=real',
          });
        }
      }
    }
    if (env.NODE_ENV === 'production' && env.SOCIAL_VERIFIER === 'fake') {
      context.addIssue({
        code: 'custom',
        path: ['SOCIAL_VERIFIER'],
        message: 'fake is not allowed in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`\n❌ Invalid environment variables:\n${details}\n`);
  }

  return parsed.data;
}
