import { z } from 'zod';
import { loadEnvFile } from './env-file';

/**
 * Server-side environment validation.
 *
 * Secrets are validated once, lazily, on first access so that a missing value
 * fails loudly at startup instead of silently at request time. Nothing in this
 * module may ever be imported from client-side code.
 */

// Reads `.env` when the framework has not already populated `process.env`.
loadEnvFile();

const isProduction = process.env.NODE_ENV === 'production';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4321),

    PUBLIC_SITE_URL: z.url().default('http://localhost:4321'),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (value) => /^postgres(ql)?:\/\//.test(value),
        'DATABASE_URL must be a postgres:// connection string',
      ),
    DATABASE_MIGRATION_URL: z.string().optional(),

    BETTER_AUTH_SECRET: z
      .string()
      .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters long'),
    BETTER_AUTH_URL: z.url().default('http://localhost:4321'),

    /**
     * Keys the derivation of ticket QR credentials. Held outside the database on
     * purpose: a database disclosure must not yield printable tickets.
     */
    TICKET_TOKEN_SECRET: z
      .string()
      .min(32, 'TICKET_TOKEN_SECRET must be at least 32 characters long'),

    PAYMENT_PROVIDER: z.enum(['razorpay', 'simulated']).default('simulated'),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

    EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    EMAIL_FROM: z.string().default('Event Hub <no-reply@example.com>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    ORDER_RESERVATION_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .default(30),

    /** Defaults used by `npm run provision` on a fresh installation. */
    PROVISION_ORG_NAME: z.string().optional(),
    PROVISION_ORG_SLUG: z.string().optional(),
    PROVISION_OWNER_EMAIL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      for (const key of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when PAYMENT_PROVIDER=razorpay`,
          });
        }
      }
    }

    if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when EMAIL_PROVIDER=smtp',
      });
    }

    if (isProduction && env.PAYMENT_PROVIDER === 'simulated') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_PROVIDER'],
        message: 'The simulated payment provider must not be used in production',
      });
    }

    if (isProduction && env.PUBLIC_SITE_URL.startsWith('http://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_SITE_URL'],
        message: 'PUBLIC_SITE_URL must use HTTPS in production',
      });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

/** Returns validated server environment variables. Throws on misconfiguration. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${details}\n\nSee .env.example for the expected values.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** True when running the clearly labelled simulated gateway for demos. */
export function usesSimulatedPayments(): boolean {
  return serverEnv().PAYMENT_PROVIDER === 'simulated';
}
