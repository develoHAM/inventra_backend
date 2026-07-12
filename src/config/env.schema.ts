import { z } from 'zod';

export const envSchema = z.object({
  // -- App --
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // -- Redis --
  REDIS_PASSWORD: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  // -- Database --
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (v) => v.startsWith('postgresql://') || v.startsWith('postgres://'),
      { message: 'must be a postgres connection string (postgresql://...)' },
    ),
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
