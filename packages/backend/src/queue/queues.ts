// Provenance: structure copied from OxyHQ/Mention packages/backend/src/queue/queues.ts,
// producers.ts and constants.ts @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main).
// One queue instead of five; the dedupe-by-hashed-jobId rule is Mention's.

import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { getQueueConnection, isRedisConfigured } from '../utils/redis';

export const MIGRATION_QUEUE = 'migration';

/** Message names on the queue: one run of a job, or the stalled-job sweep. */
const RUN_MESSAGE = 'run';
export const SWEEP_MESSAGE = 'sweep';

/**
 * Attempts per enqueue for TRANSIENT failures. A rate limit is not a failed
 * attempt (the attempt completes and a delayed message is enqueued), so this
 * budget is spent only on genuine errors, each resuming from the checkpoint.
 */
export const MIGRATION_JOB_ATTEMPTS = 6;
const MIGRATION_BACKOFF_BASE_MS = 30_000;

/** How long a dead worker's job stays locked; BullMQ renews it while alive. */
export const MIGRATION_LOCK_DURATION_MS = 2 * 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;

export interface MigrationJobData {
  jobId?: string;
}

let migrationQueue: Queue<MigrationJobData> | null = null;

function getMigrationQueue(): Queue<MigrationJobData> | null {
  if (!isRedisConfigured()) return null;
  migrationQueue ??= new Queue<MigrationJobData>(MIGRATION_QUEUE, {
    connection: getQueueConnection(),
    defaultJobOptions: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } },
  });
  return migrationQueue;
}

/**
 * Enqueue a run of `jobId`, optionally delayed. The message id carries the
 * target second: re-enqueueing the same pause twice is one message, while a
 * later resume is a new one (BullMQ ignores an add whose id it still retains).
 * Returns false when no queue is configured.
 */
export async function enqueueMigrationRun(jobId: string, delayMs = 0): Promise<boolean> {
  const queue = getMigrationQueue();
  if (!queue) return false;
  const delay = Math.max(0, delayMs);
  const runAt = Math.ceil((Date.now() + delay) / 1000);
  // A hex digest: BullMQ rejects a custom id containing `:`.
  const messageId = `migration-${createHash('sha256').update(`${jobId}|${runAt}`).digest('hex').slice(0, 40)}`;
  await queue.add(RUN_MESSAGE, { jobId }, {
    jobId: messageId,
    delay,
    attempts: MIGRATION_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: MIGRATION_BACKOFF_BASE_MS },
  });
  return true;
}

/**
 * Schedule the stalled-job sweep. A BullMQ job scheduler produces ONE message
 * per interval however many tasks call this, so the sweep needs no leader.
 */
export async function scheduleStalledSweep(): Promise<void> {
  await getMigrationQueue()?.upsertJobScheduler(SWEEP_MESSAGE, { every: SWEEP_EVERY_MS }, { name: SWEEP_MESSAGE, data: {} });
}

export async function closeQueues(): Promise<void> {
  await migrationQueue?.close().catch(() => undefined);
  migrationQueue = null;
}
