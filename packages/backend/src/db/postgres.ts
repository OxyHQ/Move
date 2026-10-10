/**
 * PostgreSQL connection for Oxy Move: drizzle over postgres.js, built through
 * `@oxy.so/db`'s `createDatabase` so queries and `drizzle.config.ts` share one
 * `DATABASE_CASING`. postgres.js rather than `drizzle-orm/bun-sql`, because the
 * image runs compiled CommonJS and `bun-sql` needs the `Bun` global.
 *
 * Connect once at boot (`connectPostgres()`), then read the handle via `getDb()`.
 */

import { createDatabase, type OxyDatabase } from '@oxy.so/db';
import { assertPostgresMigrationsCurrent, readJournal } from '@oxy.so/db/migrate';
import type postgres from 'postgres';
import { logger } from '../utils/logger';
import { MIGRATIONS_FOLDER } from './migrationsFolder';
import * as schema from './schema';

const CLOSE_TIMEOUT_SECONDS = 5;

/** The migration journal this build ships; it cannot change while the process runs. */
const JOURNAL = readJournal(MIGRATIONS_FOLDER);

export type Database = OxyDatabase<typeof schema>;

let db: Database | null = null;
let client: postgres.Sql | null = null;

/**
 * Open the pool and prove it with a round trip, so an unreachable database
 * fails startup instead of the first request. Idempotent.
 */
export async function connectPostgres(): Promise<Database> {
  if (db) return db;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. See packages/backend/.env.example.');
  }
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: (notice) => logger.info('Postgres notice', notice.message),
    },
  });
  try {
    await instance.client`select 1`;
  } catch (error) {
    await instance.client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    throw error;
  }
  client = instance.client;
  db = instance.db;
  logger.info('Connected to PostgreSQL');
  return db;
}

export function getDb(): Database {
  if (!db) throw new Error('PostgreSQL is not connected. Call connectPostgres() during startup.');
  return db;
}

/** Whether the database answers a real query right now. Never throws. */
export async function checkPostgresHealth(): Promise<boolean> {
  if (!client) return false;
  try {
    await client`select 1`;
    return true;
  } catch (error) {
    logger.error('Postgres health check failed', error);
    return false;
  }
}

/**
 * Throws unless every migration this build ships is applied — so a task started
 * against an unmigrated database never reports ready (`GET /ready`).
 */
export async function assertMigrationsCurrent(): Promise<void> {
  if (!client) throw new Error('PostgreSQL is not connected.');
  await assertPostgresMigrationsCurrent(client, JOURNAL);
}

/** Close the pool (shutdown). Safe to call when never connected. */
export async function closePostgres(): Promise<void> {
  const open = client;
  client = null;
  db = null;
  await open?.end({ timeout: CLOSE_TIMEOUT_SECONDS });
}
