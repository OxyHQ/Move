/**
 * Apply the SQL migrations in `packages/backend/drizzle/` to `DATABASE_URL` —
 * the ONE migration mechanism (never `drizzle-kit migrate`, a devDependency the
 * image does not ship). Production runs the compiled `dist/src/db/migrate.js` as
 * a one-shot task.
 *
 *     bun run db:migrate --target-database=<name> [--phase=pre|post|all]
 *
 * `--target-database` is required on every run: pointed at the wrong database a
 * migrator finds an empty ledger, applies everything and exits 0. `--phase`
 * (default `all`) selects `pre` (additive, before the rollout) or `post`
 * (destructive, after it); an unmarked `.sql` fails before any DDL runs.
 * `DRY_RUN=true` reports without writing.
 */

import {
  MIGRATION_RUNS,
  readTargetDatabase,
  runMigrations,
  type MigrationRun,
  type RequiredExtension,
} from '@oxy.so/db/migrate';
import { logger } from '../utils/logger';
import { MIGRATIONS_FOLDER } from './migrationsFolder';

/** Extensions the schema needs, ensured before any migration (none today). */
const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [];

/** Whether `DRY_RUN` asks for a report instead of an apply. */
function isDryRun(): boolean {
  const value = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** `--phase=<pre|post|all>`, default `all`; an unknown value throws rather than guess. */
function readPhase(argv: readonly string[]): MigrationRun {
  const prefix = '--phase=';
  const flag = argv.find((arg) => arg.startsWith(prefix));
  if (!flag) return 'all';

  const value = flag.slice(prefix.length).trim();
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new Error(
      `Unrecognised --phase=${JSON.stringify(value)}. Use one of: ${MIGRATION_RUNS.join(', ')}.`,
    );
  }
  return value as MigrationRun;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const expectedDatabase = readTargetDatabase(argv);
  const run = readPhase(argv);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. See packages/backend/.env.example.');
  }

  await runMigrations({
    databaseUrl,
    migrationsFolder: MIGRATIONS_FOLDER,
    extensions: REQUIRED_EXTENSIONS,
    run,
    expectedDatabase,
    dryRun: isDryRun(),
    logger,
  });
}

main().catch((error: unknown) => {
  logger.error('Postgres migration failed', error);
  process.exitCode = 1;
});
