/**
 * The ONE place Oxy Move reads its environment, parsed once with zod.
 *
 * Production values come from the ECS task definition (oxy-infra
 * `terraform-uswest2/app-move.tf`). There is no `OXY_SERVICE_API_KEY` pair in
 * production: Move attests its task role (`oxy-move-task`, oxy ADR 0026) and
 * `@oxy.so/core` mints the service token from that. The pair is honoured when
 * present, for local development. `DATABASE_URL` is read by `db/postgres.ts`
 * at connect time so the tests can point it at their own database.
 */

import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value, context) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        context.addIssue({
          code: 'custom',
          message: `must be a positive integer, got ${JSON.stringify(value)}`,
        });
        return z.NEVER;
      }
      return parsed;
    });

const url = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value && value.trim() ? value.trim() : fallback))
    .pipe(z.string().url())
    .transform((value) => value.replace(/\/+$/, ''));

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional().default('development'),
  PORT: positiveInt(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),

  OXY_API_URL: url('https://api.oxy.so'),
  MENTION_API_URL: url('https://api.mention.earth'),
  OXY_SERVICE_API_KEY: optionalString,
  OXY_SERVICE_API_SECRET: optionalString,

  /** Queue, fleet-wide media limiter. Unset locally: jobs then run in-process. */
  REDIS_URL: optionalString,

  /** Oxy's per-app budget for `/assets/service/user-media` (~30/min/app). */
  MEDIA_UPLOADS_PER_MINUTE: positiveInt(30),
  /** Largest remote media file Move will copy into Oxy, in bytes. */
  MEDIA_MAX_BYTES: positiveInt(100 * 1024 * 1024),
  /** Concurrency of the `migration` worker per process. */
  MIGRATION_WORKER_CONCURRENCY: positiveInt(2),
});

const parsed = environmentSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid Oxy Move environment: ${issues}`);
}
const environment = parsed.data;

export const config = {
  runtime: {
    isProduction: environment.NODE_ENV === 'production',
    isTest: environment.NODE_ENV === 'test',
    port: environment.PORT,
  },
  logLevel: environment.LOG_LEVEL ?? (environment.NODE_ENV === 'production' ? 'info' : 'debug'),
  oxyApiUrl: environment.OXY_API_URL,
  mentionApiUrl: environment.MENTION_API_URL,
  oxyServiceCredentials: {
    apiKey: environment.OXY_SERVICE_API_KEY,
    apiSecret: environment.OXY_SERVICE_API_SECRET,
  },
  redisUrl: environment.REDIS_URL,
  media: {
    uploadsPerMinute: environment.MEDIA_UPLOADS_PER_MINUTE,
    maxBytes: environment.MEDIA_MAX_BYTES,
  },
  workerConcurrency: environment.MIGRATION_WORKER_CONCURRENCY,
} as const;
