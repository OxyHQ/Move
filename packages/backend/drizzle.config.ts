import { DATABASE_CASING } from '@oxy.so/db';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit, for `bun run db:generate` only (migrations are applied by
 * `src/db/migrate.ts`). `casing` is the same `DATABASE_CASING` the runtime uses.
 * After each generate, add `-- oxy:deploy-phase=pre|post` to the new `.sql`.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required by drizzle-kit. Start a local Postgres with:\n' +
      '  docker compose -f ../../docker-compose.postgres.yml up -d postgres\n' +
      'then set DATABASE_URL in packages/backend/.env.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  casing: DATABASE_CASING,
  strict: true,
  verbose: true,
  dbCredentials: { url },
});
