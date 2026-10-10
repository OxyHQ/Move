/**
 * A throwaway Postgres database per test file, migrated with the SAME migrator
 * and journal production uses.
 *
 * Requires `TEST_DATABASE_URL` (any database on a server the tests may create
 * databases on). It REFUSES to run without one rather than skipping: a skipped
 * pipeline test is a green run that gated nothing.
 */

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from '@oxy.so/db/migrate';
import { MIGRATIONS_FOLDER } from '../../db/migrationsFolder';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface TestDatabase {
  db: Database;
  name: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      'TEST_DATABASE_URL is required for the pipeline tests (e.g. postgres://oxy:oxy@127.0.0.1:5432/oxy_dev). ' +
        'They create and drop their own database and never skip.',
    );
  }
  const name = `move_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`create database "${name}"`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await runMigrations({
    databaseUrl: url.toString(),
    migrationsFolder: MIGRATIONS_FOLDER,
    extensions: [],
    run: 'all',
    expectedDatabase: name,
    dryRun: false,
    logger: quietLogger,
  });

  process.env.DATABASE_URL = url.toString();
  const db = await connectPostgres();

  return {
    db,
    name,
    async drop() {
      await closePostgres();
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => undefined });
      await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
      await cleanup.end();
    },
  };
}
