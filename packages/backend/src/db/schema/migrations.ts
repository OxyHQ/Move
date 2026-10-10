/**
 * Oxy Move's whole database: migration STATE, and nothing else.
 *
 * Move owns no identity, no profile, no graph and no content. Oxy owns the
 * account, the linked external accounts, the profile and the follows; Mention
 * owns the imported posts. What lives here is only what it takes to run, resume,
 * deduplicate and undo a migration: the job, its cursors, and the
 * `source -> destination` map.
 *
 * ## Conventions (Oxy/Mention)
 *
 * - Closed sets are `text` + a CHECK rendered from a `const` tuple with
 *   `inList`, never a Postgres enum: widening a CHECK is an additive `pre`
 *   migration, widening an enum is not.
 * - Timestamps are `timestamptz` at millisecond precision (`@oxy.so/db`).
 * - Ids are app-generated uuid v7 text (`generatedId()`).
 * - `oxyUserId` and `linkedAccountId` are FOREIGN services' keys (Oxy), so they
 *   carry no foreign key here.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  ACTIVE_JOB_STATUSES,
  JOB_STATUSES,
  MIGRATION_PLATFORMS,
  type JobCounters,
  type JobOptions,
  type JobPhases,
  type MigrationPlan,
  type PlanAck,
  type PlanUndoFacts,
} from '@move/shared-types';

/** Where an item was written. */
export const MIGRATION_DESTINATIONS = ['mention'] as const;
export type MigrationDestination = (typeof MIGRATION_DESTINATIONS)[number];

/** What a source item is. */
export const MIGRATION_ITEM_KINDS = ['post', 'article', 'boost'] as const;
export type MigrationItemKind = (typeof MIGRATION_ITEM_KINDS)[number];

/**
 * - `pending`  — its media were copied into Oxy (`media_assets`) but the item is
 *   not confirmed by the destination yet; a retry reuses those assets.
 * - `deferred` — its parent (reply or self-quote) is not in the destination yet
 *   (held back locally, or answered `deferred` by Mention); it is re-sent once
 *   the target lands, or standalone at the end.
 * - `sent`     — the destination created it (`destination_id` set).
 * - `existing` — the destination already had it (idempotent resend, adoption).
 * - `failed`   — the destination refused it; `last_error` says why.
 * - `undone`   — removed again by an undo.
 */
export const MIGRATION_ITEM_STATUSES = [
  'pending',
  'deferred',
  'sent',
  'existing',
  'failed',
  'undone',
] as const;
export type MigrationItemStatus = (typeof MIGRATION_ITEM_STATUSES)[number];

/** The resumable position of each phase. Opaque to everything but its source. */
export interface JobCursor {
  graph?: unknown;
  content?: unknown;
}

export const migrationJobs = pgTable(
  'migration_jobs',
  {
    id: generatedId(),
    /** Oxy account id — Oxy owns identity, so no foreign key. */
    oxyUserId: text().notNull(),
    platform: text().notNull().$type<(typeof MIGRATION_PLATFORMS)[number]>(),
    /** Oxy `user_linked_accounts` id the user proved ownership of. */
    linkedAccountId: text().notNull(),
    /** Actor URI (ActivityPub) or DID (atproto) of the account being moved. */
    sourceActor: text().notNull(),
    sourceHandle: text(),
    status: text().notNull().default('queued').$type<(typeof JOB_STATUSES)[number]>(),
    phases: jsonb().notNull().$type<JobPhases>(),
    counters: jsonb().notNull().$type<JobCounters>(),
    cursor: jsonb().notNull().default({}).$type<JobCursor>(),
    options: jsonb().notNull().$type<JobOptions>(),
    /** The client-applied plan (profile fields, resolved follow and block batches). */
    plan: jsonb()
      .notNull()
      .default({ profile: null, graph: null, blocks: null })
      .$type<MigrationPlan>(),
    planAck: jsonb().$type<PlanAck>(),
    /**
     * What the client recorded BEFORE applying the plan (the profile it
     * overwrote, the targets already followed/blocked), so undo on any device
     * reverses only what Move did. First write wins, per fact.
     */
    undoFacts: jsonb().$type<PlanUndoFacts>(),
    /** Last failure as a stable code plus detail; null while healthy. */
    error: text(),
    /** Set while `paused` by a rate limit: the worker is re-enqueued for then. */
    pausedUntil: timestamptz(),
    /** Whether Mention's batch has been deleted by an undo (idempotence). */
    destinationUndone: boolean().notNull().default(false),
    /** What the last undo reported: posts deleted, and posts the destination failed to delete. */
    undoResult: jsonb().$type<{ deleted: number; failed: number }>(),
    startedAt: timestamptz(),
    finishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'migration_jobs_platform_check',
      sql`${t.platform} in (${sql.raw(inList(MIGRATION_PLATFORMS))})`,
    ),
    check('migration_jobs_status_check', sql`${t.status} in (${sql.raw(inList(JOB_STATUSES))})`),
    // At most ONE active job per user and platform. Partial, so finished jobs
    // (history) never block a new one, and enforced by the database so two
    // concurrent `POST /jobs` cannot both win.
    uniqueIndex('migration_jobs_one_active_per_user_platform')
      .on(t.oxyUserId, t.platform)
      .where(sql`${t.status} in (${sql.raw(inList(ACTIVE_JOB_STATUSES))})`),
    // "This user's migrations, newest first" — the history screen.
    index('migration_jobs_oxy_user_id_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
    // The stalled-job sweep reads active jobs only.
    index('migration_jobs_active_idx')
      .on(t.status, t.updatedAt)
      .where(sql`${t.status} in (${sql.raw(inList(ACTIVE_JOB_STATUSES))})`),
  ],
);

export const migrationItems = pgTable(
  'migration_items',
  {
    jobId: text()
      .notNull()
      .references(() => migrationJobs.id, { onDelete: 'cascade' }),
    /** The source's stable id: AS2 object id or AT-URI. */
    sourceId: text().notNull(),
    kind: text().notNull().$type<MigrationItemKind>(),
    destination: text().notNull().default('mention').$type<MigrationDestination>(),
    /** The destination's id for it (Mention post id); null until sent. */
    destinationId: text(),
    status: text().notNull().$type<MigrationItemStatus>(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    /** Source timestamp; the deferred pass re-sends oldest first. */
    sourceCreatedAt: timestamptz(),
    /**
     * The mapped item, kept ONLY while `deferred` so the final pass can resend it
     * without re-reading the source. Cleared once sent.
     */
    payload: jsonb(),
    /**
     * Source media URL → Oxy asset id, written after EACH upload and before the
     * item is sent, so a crash between upload and delivery never re-uploads.
     */
    mediaAssets: jsonb().$type<Record<string, string>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'migration_items_pkey', columns: [t.jobId, t.sourceId] }),
    check(
      'migration_items_kind_check',
      sql`${t.kind} in (${sql.raw(inList(MIGRATION_ITEM_KINDS))})`,
    ),
    check(
      'migration_items_destination_check',
      sql`${t.destination} in (${sql.raw(inList(MIGRATION_DESTINATIONS))})`,
    ),
    check(
      'migration_items_status_check',
      sql`${t.status} in (${sql.raw(inList(MIGRATION_ITEM_STATUSES))})`,
    ),
    check('migration_items_attempts_check', sql`${t.attempts} >= 0`),
    // The deferred pass: "this job's deferred children, oldest first".
    index('migration_items_job_status_idx').on(t.jobId, t.status, t.sourceCreatedAt),
  ],
);

export type MigrationJob = typeof migrationJobs.$inferSelect;
