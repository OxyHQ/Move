/**
 * What the API does with jobs. Every method takes the AUTHENTICATED Oxy user id
 * (never one from the request body) and only ever touches that user's rows.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { isUniqueViolation } from '@oxy.so/db';
import {
  ACTIVE_JOB_STATUSES,
  DEFAULT_JOB_OPTIONS,
  type JobCounters,
  type JobOptions,
  type JobPhases,
  type MigrationJobView,
  type MigrationPlatform,
  type MigrationPreview,
  type PlanAck,
  type PlanAckRequest,
  type PlanResponse,
  type PlanUndoFacts,
} from '@move/shared-types';
import type { Database } from '../db/postgres';
import { migrationItems, migrationJobs, type MigrationJob } from '../db/schema';
import type { ContentDestination } from '../destinations/types';
import type { OxyGateway } from '../destinations/oxy';
import type { SourceFactory } from '../sources';
import type { ProgressSink } from './runner';

const EMPTY_COUNTERS: JobCounters = {
  read: 0,
  created: 0,
  existing: 0,
  failed: 0,
  skipped: 0,
  deferred: 0,
  mediaUploaded: 0,
  followsRead: 0,
  followsResolved: 0,
};

const INITIAL_PHASES: JobPhases = {
  profile: { status: 'pending' },
  graph: { status: 'pending' },
  content: { status: 'pending' },
};

export function toJobView(job: MigrationJob): MigrationJobView {
  return {
    id: job.id,
    platform: job.platform,
    linkedAccountId: job.linkedAccountId,
    sourceActor: job.sourceActor,
    sourceHandle: job.sourceHandle,
    status: job.status,
    phases: job.phases,
    counters: job.counters,
    options: job.options,
    error: job.error,
    pausedUntil: job.pausedUntil?.toISOString() ?? null,
    planAck: job.planAck ?? null,
    undo: job.undoResult ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export class JobConflictError extends Error {
  constructor() {
    super('an active migration already exists for this platform');
    this.name = 'JobConflictError';
  }
}

export class JobNotFoundError extends Error {
  constructor() {
    super('job not found');
    this.name = 'JobNotFoundError';
  }
}

export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobStateError';
  }
}

export interface JobServiceDeps {
  db: Database;
  oxy: OxyGateway;
  destination: ContentDestination;
  sourceFactory: SourceFactory;
  progress: ProgressSink;
  /** Hand a job id to the worker (or run it inline without Redis). */
  enqueue: (jobId: string) => Promise<void>;
}

/** Undo: what the backend did, and everything the client needs to reverse the rest. */
export interface UndoResult extends PlanResponse {
  job: MigrationJob;
  deleted: number;
  failed: number;
}

export class JobService {
  constructor(private readonly deps: JobServiceDeps) {}

  private async owned(oxyUserId: string, jobId: string): Promise<MigrationJob> {
    const rows = await this.deps.db
      .select()
      .from(migrationJobs)
      .where(and(eq(migrationJobs.id, jobId), eq(migrationJobs.oxyUserId, oxyUserId)));
    if (!rows[0]) throw new JobNotFoundError();
    return rows[0];
  }

  /** The read-only preview (`dryRun`): verified account, counts, date range, profile. */
  async preview(oxyUserId: string, platform: MigrationPlatform, linkedAccountId: string): Promise<MigrationPreview> {
    const account = await this.deps.oxy.verifyLinkedAccount(oxyUserId, linkedAccountId, platform);
    const source = await this.deps.sourceFactory(account);
    const profile = await source.profile();
    const range = source.dateRange ? await source.dateRange().catch(() => ({})) : {};
    return {
      platform,
      sourceActor: account.actor,
      handle: profile.handle,
      profile: {
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.bio ? { bio: profile.bio } : {}),
        ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      },
      counts: {
        ...(profile.postsCount !== undefined ? { posts: profile.postsCount } : {}),
        ...(profile.followingCount !== undefined ? { following: profile.followingCount } : {}),
        ...(profile.followersCount !== undefined ? { followers: profile.followersCount } : {}),
      },
      ...range,
      graphHidden: profile.graphHidden === true,
    };
  }

  async create(
    oxyUserId: string,
    input: { platform: MigrationPlatform; linkedAccountId: string; options?: Partial<JobOptions> },
  ): Promise<MigrationJob> {
    // Ownership is verified BEFORE anything is written: a job never exists for
    // an account the user has not proven is theirs.
    const account = await this.deps.oxy.verifyLinkedAccount(oxyUserId, input.linkedAccountId, input.platform);
    const options: JobOptions = { ...DEFAULT_JOB_OPTIONS, ...(input.options ?? {}) };
    let job: MigrationJob;
    try {
      const rows = await this.deps.db
        .insert(migrationJobs)
        .values({
          oxyUserId,
          platform: input.platform,
          linkedAccountId: input.linkedAccountId,
          sourceActor: account.actor,
          sourceHandle: account.handle,
          status: 'queued',
          phases: INITIAL_PHASES,
          counters: EMPTY_COUNTERS,
          options,
        })
        .returning();
      job = rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new JobConflictError();
      throw error;
    }
    await this.deps.enqueue(job.id);
    return job;
  }

  async list(oxyUserId: string): Promise<MigrationJob[]> {
    return this.deps.db
      .select()
      .from(migrationJobs)
      .where(eq(migrationJobs.oxyUserId, oxyUserId))
      .orderBy(desc(migrationJobs.createdAt))
      .limit(100);
  }

  async get(oxyUserId: string, jobId: string): Promise<MigrationJob> {
    return this.owned(oxyUserId, jobId);
  }

  /**
   * The plan for the client to apply. Follow and block batches appear only once
   * the graph phase has finished: until then the last batch is still growing,
   * and a client that applied and acked it would never see the accounts added
   * to it afterwards.
   */
  async plan(oxyUserId: string, jobId: string): Promise<PlanResponse> {
    const job = await this.owned(oxyUserId, jobId);
    const graphFinal = job.phases.graph.status === 'done' || job.phases.graph.status === 'skipped';
    return {
      plan: graphFinal ? job.plan : { ...job.plan, graph: null, blocks: null },
      ack: job.planAck ?? null,
      undoFacts: job.undoFacts ?? null,
    };
  }

  /**
   * Record what the client applied and the facts to undo it. Row-locked, so
   * two devices acking at once cannot lose each other's writes. Indexes are
   * range-checked; a fact names only targets of ITS batch; and every fact is
   * first-write-wins (see `PlanUndoFacts`).
   */
  async ackPlan(oxyUserId: string, jobId: string, ack: PlanAckRequest): Promise<MigrationJob> {
    await this.owned(oxyUserId, jobId);
    return this.deps.db.transaction(async (tx) => {
      const [job] = await tx.select().from(migrationJobs).where(eq(migrationJobs.id, jobId)).for('update');
      const followBatches = job.plan.graph?.followBatches ?? [];
      const blockBatches = job.plan.blocks?.blockBatches ?? [];

      const merged = (recorded: number[] | undefined, incoming: number[] | undefined, size: number, what: string) => {
        const all = new Set([...(recorded ?? []), ...(incoming ?? [])]);
        for (const index of all) {
          if (!Number.isInteger(index) || index < 0 || index >= size) throw new JobStateError(`${what} batch index out of range`);
        }
        return [...all].sort((a, b) => a - b);
      };
      const planAck: PlanAck = {
        profileApplied: ack.profileApplied || job.planAck?.profileApplied || false,
        followBatchesApplied: merged(job.planAck?.followBatchesApplied, ack.followBatchesApplied, followBatches.length, 'follow'),
        blockBatchesApplied: merged(job.planAck?.blockBatchesApplied, ack.blockBatchesApplied, blockBatches.length, 'block'),
      };

      const facts: PlanUndoFacts = { ...(job.undoFacts ?? {}) };
      if (ack.profileBefore && !facts.profileBefore) {
        if (!job.plan.profile) throw new JobStateError('the plan has no profile');
        facts.profileBefore = ack.profileBefore;
      }
      const firstWins = (recorded: Record<string, string[]> | undefined, incoming: Record<string, string[]> | undefined, batches: string[][], what: string) => {
        const out = { ...(recorded ?? {}) };
        for (const [key, ids] of Object.entries(incoming ?? {})) {
          const batch = /^\d+$/.test(key) ? batches[Number(key)] : undefined;
          if (!batch) throw new JobStateError(`${what} batch index out of range`);
          const members = new Set(batch);
          if (!ids.every((id) => members.has(id))) throw new JobStateError(`${what} fact names an account outside its batch`);
          if (!(key in out)) out[key] = [...new Set(ids)];
        }
        return out;
      };
      if (ack.alreadyFollowing) facts.alreadyFollowing = firstWins(facts.alreadyFollowing, ack.alreadyFollowing, followBatches, 'follow');
      if (ack.alreadyBlocked) facts.alreadyBlocked = firstWins(facts.alreadyBlocked, ack.alreadyBlocked, blockBatches, 'block');

      const rows = await tx
        .update(migrationJobs)
        .set({ planAck, undoFacts: facts, updatedAt: new Date() })
        .where(eq(migrationJobs.id, job.id))
        .returning();
      return rows[0];
    });
  }

  async cancel(oxyUserId: string, jobId: string): Promise<MigrationJob> {
    const job = await this.owned(oxyUserId, jobId);
    const rows = await this.deps.db
      .update(migrationJobs)
      .set({ status: 'cancelled', finishedAt: new Date(), pausedUntil: null, updatedAt: new Date() })
      .where(and(eq(migrationJobs.id, job.id), inArray(migrationJobs.status, [...ACTIVE_JOB_STATUSES])))
      .returning();
    if (!rows[0]) throw new JobStateError(`job is ${job.status}, not active`);
    this.deps.progress.emit(oxyUserId, rows[0]);
    return rows[0];
  }

  /**
   * Undo: stop the job if it is still running, then remove every post Mention
   * created for it (`DELETE /imports/v1/batches/:jobId`, which deletes through
   * Mention's normal path and federates the `Delete`s). The profile and follows
   * are the CLIENT's to revert — it holds the only session Oxy accepts for them —
   * so the plan is returned for it to reverse.
   */
  async undo(oxyUserId: string, jobId: string): Promise<UndoResult> {
    let job = await this.owned(oxyUserId, jobId);
    if (job.status === 'undone' && job.destinationUndone) {
      return { job, deleted: 0, failed: 0, plan: job.plan, ack: job.planAck ?? null, undoFacts: job.undoFacts ?? null };
    }
    if ((ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status)) {
      await this.deps.db
        .update(migrationJobs)
        .set({ status: 'cancelled', finishedAt: new Date(), pausedUntil: null, updatedAt: new Date() })
        .where(and(eq(migrationJobs.id, job.id), inArray(migrationJobs.status, [...ACTIVE_JOB_STATUSES])));
    }
    // Mention deletes through its normal path (federated Deletes included) and
    // reports what it could NOT delete. With failures the job is `undone` but
    // not `destinationUndone`, so calling undo again retries only what is left.
    const { deleted, failed } = await this.deps.destination.undo({ oxyUserId, batchId: job.id });
    await this.deps.db.transaction(async (tx) => {
      if (failed === 0) {
        await tx
          .update(migrationItems)
          .set({ status: 'undone', updatedAt: new Date() })
          .where(and(eq(migrationItems.jobId, job.id), inArray(migrationItems.status, ['pending', 'sent', 'existing', 'deferred'])));
      }
      const rows = await tx
        .update(migrationJobs)
        .set({
          status: 'undone',
          destinationUndone: failed === 0,
          undoResult: { deleted: (job.undoResult?.deleted ?? 0) + deleted, failed },
          updatedAt: new Date(),
        })
        .where(eq(migrationJobs.id, job.id))
        .returning();
      job = rows[0];
    });
    this.deps.progress.emit(oxyUserId, job);
    return { job, deleted, failed, plan: job.plan, ack: job.planAck ?? null, undoFacts: job.undoFacts ?? null };
  }
}
