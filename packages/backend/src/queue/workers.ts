// Provenance: structure copied from OxyHQ/Mention packages/backend/src/queue/workers.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main): started once per
// process, closed on shutdown, failures logged. The processor is Move's.

import { Worker, type Job } from 'bullmq';
import { and, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { migrationJobs } from '../db/schema';
import { logger } from '../utils/logger';
import { getQueueConnection, isRedisConfigured } from '../utils/redis';
import { failJob, runMigrationJob, type PipelineDeps } from '../pipeline/runner';
import {
  MIGRATION_JOB_ATTEMPTS,
  MIGRATION_LOCK_DURATION_MS,
  MIGRATION_QUEUE,
  SWEEP_MESSAGE,
  closeQueues,
  enqueueMigrationRun,
  type MigrationJobData,
} from './queues';

/** A `queued`/`running` job untouched this long has lost its worker or its message. */
const STALLED_AFTER_MS = 15 * 60_000;

let migrationWorker: Worker<MigrationJobData> | null = null;

/**
 * Process one run message. A pause is not an error: the attempt COMPLETES and
 * a delayed message is enqueued for `resumeAt`. A transient error throws so
 * BullMQ retries with backoff; the last attempt marks the job failed.
 */
export async function processMigrationMessage(
  job: Pick<Job<MigrationJobData>, 'data' | 'attemptsMade'>,
  deps: PipelineDeps,
  reschedule: (jobId: string, delayMs: number) => Promise<unknown> = enqueueMigrationRun,
): Promise<void> {
  const jobId = job.data.jobId;
  if (!jobId) return;
  const outcome = await runMigrationJob(jobId, deps);
  if (outcome.status === 'paused') {
    await reschedule(jobId, outcome.resumeAt.getTime() - Date.now());
  } else if (outcome.status === 'retry') {
    if (job.attemptsMade + 1 >= MIGRATION_JOB_ATTEMPTS) {
      await failJob(deps, jobId, 'retries-exhausted', outcome.error instanceof Error ? outcome.error.message.slice(0, 200) : undefined);
      return;
    }
    throw outcome.error instanceof Error ? outcome.error : new Error('transient migration failure');
  }
}

/**
 * Re-enqueue active jobs that lost their message: a `queued`/`running` job
 * untouched for {@link STALLED_AFTER_MS} (its worker died, or Redis lost the
 * message) and a `paused` job whose resume time passed that long ago. The
 * runner resumes each from its checkpoint.
 */
async function sweepStalledJobs(deps: Pick<PipelineDeps, 'db'>): Promise<number> {
  const stalledBefore = new Date(Date.now() - STALLED_AFTER_MS);
  const rows = await deps.db
    .select({ id: migrationJobs.id })
    .from(migrationJobs)
    .where(
      or(
        and(inArray(migrationJobs.status, ['queued', 'running']), lt(migrationJobs.updatedAt, stalledBefore)),
        and(eq(migrationJobs.status, 'paused'), isNotNull(migrationJobs.pausedUntil), lt(migrationJobs.pausedUntil, stalledBefore)),
      ),
    )
    .limit(100);
  for (const row of rows) await enqueueMigrationRun(row.id);
  if (rows.length > 0) logger.info('[queue] re-enqueued stalled migrations', { count: rows.length });
  return rows.length;
}

/** Start the `migration` worker (idempotent; no-op without Redis). */
export function startWorkers(deps: PipelineDeps, concurrency: number): void {
  if (migrationWorker || !isRedisConfigured()) return;
  migrationWorker = new Worker<MigrationJobData>(
    MIGRATION_QUEUE,
    async (job) => {
      if (job.name === SWEEP_MESSAGE) await sweepStalledJobs(deps);
      else await processMigrationMessage(job, deps);
    },
    { connection: getQueueConnection(), concurrency, lockDuration: MIGRATION_LOCK_DURATION_MS },
  );
  migrationWorker.on('failed', (_job, error) => logger.warn('[queue] migration attempt failed', { error }));
  migrationWorker.on('error', (error) => logger.error('[queue] migration worker error', error));
}

export async function shutdownQueues(): Promise<void> {
  await migrationWorker?.close().catch(() => undefined);
  migrationWorker = null;
  await closeQueues();
}
