/**
 * One run of one migration job: profile -> graph -> content, resumable at every
 * checkpoint.
 *
 * ## The invariants this file keeps
 *
 * - **Resume, never restart.** Each phase persists its source cursor at every
 *   checkpoint (every flushed batch, and every {@link CHECKPOINT_EVERY} reads
 *   otherwise). A run that dies — deploy, crash, rate-limit pause — continues
 *   from the last checkpoint, and a finished phase is never re-run.
 * - **Idempotent resend.** Between a delivery and its checkpoint a crash can
 *   resend a batch. Mention answers a repeated `sourceId` with `existing` and the
 *   same post id, and `migration_items` is upserted on `(job_id, source_id)`, so a
 *   resend changes nothing but a counter.
 * - **Parents first.** Sources read newest first, so a self-reply usually
 *   arrives BEFORE its parent. A child whose parent (reply or self-quote) is not
 *   delivered yet is stored `deferred` with its mapped payload and re-sent after
 *   the source is exhausted, oldest first, in waves until nothing more becomes
 *   ready; what is left is sent anyway and Mention resolves what it can.
 * - **Pause, never fail, on a rate limit** (see `errors.ts`).
 * - **Cancellation is observed at every checkpoint.**
 */

import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  ACTIVE_JOB_STATUSES,
  type JobCounters,
  type JobPhases,
  type MigrationPlan,
  type PhaseName,
} from '@move/shared-types';
import type { Database } from '../db/postgres';
import { migrationItems, migrationJobs, type MigrationJob } from '../db/schema';
import { logger } from '../utils/logger';
import type { ContentDestination, DeliveryResult, PreparedItem } from '../destinations/types';
import type { MediaCopier } from '../destinations/media';
import { toFollowBatches, type OxyGateway } from '../destinations/oxy';
import type { SourceFactory } from '../sources';
import { isSkipped, type GraphAccount, type Source, type SourceItem } from '../sources/types';
import { classify, JobCancelledError, type Disposition } from './errors';

/** Reads between cursor checkpoints when nothing is being delivered. */
const CHECKPOINT_EVERY = 50;
/** Followed accounts resolved per Oxy round. */
const GRAPH_CHUNK = 100;

export interface ProgressSink {
  emit(oxyUserId: string, job: MigrationJob): void;
}

export interface PipelineDeps {
  db: Database;
  oxy: OxyGateway;
  destination: ContentDestination;
  media: MediaCopier;
  sourceFactory: SourceFactory;
  progress: ProgressSink;
  now?: () => Date;
}

export type RunOutcome =
  | { status: 'done' | 'failed' | 'cancelled' | 'undone' | 'missing' }
  | { status: 'paused'; resumeAt: Date }
  | { status: 'retry'; error: unknown };

type JobPatch = Partial<Pick<MigrationJob, 'status' | 'phases' | 'cursor' | 'plan' | 'error' | 'pausedUntil' | 'startedAt' | 'finishedAt' | 'sourceHandle'>>;

class JobRun {
  private job: MigrationJob;
  private readonly now: () => Date;
  /** Source ids delivered (sent/existing) this run, to avoid a query per child. */
  private readonly delivered = new Set<string>();

  constructor(job: MigrationJob, private readonly deps: PipelineDeps) {
    this.job = job;
    this.now = deps.now ?? (() => new Date());
  }

  private get counters(): JobCounters {
    return this.job.counters;
  }

  /**
   * Persist a patch — and the in-memory counters, which every save carries —
   * but ONLY while the job is still active: a cancel or undo wins.
   */
  private async save(patch: JobPatch = {}): Promise<void> {
    const rows = await this.deps.db
      .update(migrationJobs)
      .set({ counters: this.counters, ...patch, updatedAt: this.now() })
      .where(and(eq(migrationJobs.id, this.job.id), inArray(migrationJobs.status, [...ACTIVE_JOB_STATUSES])))
      .returning();
    if (rows.length === 0) throw new JobCancelledError();
    this.job = rows[0];
    this.deps.progress.emit(this.job.oxyUserId, this.job);
  }

  private async setPhase(name: PhaseName, status: JobPhases[PhaseName]['status'], reason?: string): Promise<void> {
    const phases: JobPhases = { ...this.job.phases, [name]: { status, ...(reason ? { reason } : {}) } };
    await this.save({ phases });
  }

  async run(): Promise<void> {
    await this.save({ status: 'running', startedAt: this.job.startedAt ?? this.now(), pausedUntil: null, error: null });

    const account = await this.deps.oxy.verifyLinkedAccount(this.job.oxyUserId, this.job.linkedAccountId, this.job.platform);
    if (account.actor !== this.job.sourceActor) {
      throw Object.assign(new Error('linked account changed since the job was created'), { moveCode: 'linked-account-changed' });
    }
    const source = await this.deps.sourceFactory(account);

    // A finished phase is never re-run; each resumes from its own cursor.
    const pending = (name: PhaseName) => this.job.phases[name].status !== 'done' && this.job.phases[name].status !== 'skipped';
    if (pending('profile')) {
      if (this.job.options.profile) await this.profilePhase(source);
      else await this.setPhase('profile', 'skipped', 'option-off');
    }
    if (pending('graph')) {
      if (this.job.options.graph) await this.graphPhase(source);
      else await this.setPhase('graph', 'skipped', 'option-off');
    }
    if (pending('content')) {
      if (this.job.options.content) await this.contentPhase(source);
      else await this.setPhase('content', 'skipped', 'option-off');
    }

    await this.save({ status: 'done', finishedAt: this.now() });
    try {
      await this.deps.oxy.notifyMigrationDone({
        oxyUserId: this.job.oxyUserId,
        jobId: this.job.id,
        platform: this.job.platform,
        created: this.counters.created,
      });
    } catch (error) {
      // The migration is done whether or not the bell rings.
      logger.warn('[pipeline] completion notification failed', error);
    }
  }

  private async profilePhase(source: Source): Promise<void> {
    await this.setPhase('profile', 'running');
    const profile = await source.profile();
    // Oxy profiles have an avatar and no banner, so only the avatar is copied.
    const [avatar] = profile.avatarUrl ? await this.deps.media.copy(this.job.oxyUserId, [{ url: profile.avatarUrl, mimeType: 'image/jpeg' }]) : [];
    if (avatar) this.counters.mediaUploaded++;
    const plan: MigrationPlan = {
      ...this.job.plan,
      profile: {
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.bio ? { bio: profile.bio } : {}),
        ...(avatar ? { avatarFileId: avatar.assetId } : {}),
        ...(profile.links ? { links: profile.links } : {}),
      },
    };
    const phases: JobPhases = { ...this.job.phases, profile: { status: 'done' } };
    // A hidden follow list is known only here; recording it now means a resumed
    // run cannot read the graph it was told to leave alone.
    if (profile.graphHidden && this.job.options.graph) {
      plan.graph = { followBatches: [], unresolved: 0, hidden: true };
      phases.graph = { status: 'skipped', reason: 'hidden' };
    }
    await this.save({ plan, phases, sourceHandle: profile.handle });
  }

  private async graphPhase(source: Source): Promise<void> {
    await this.setPhase('graph', 'running');
    const followIds = (this.job.plan.graph?.followBatches ?? []).flat();
    const blockIds = (this.job.plan.blocks?.blockBatches ?? []).flat();
    let blocksRead = this.job.plan.blocks?.read ?? 0;
    let chunk: GraphAccount[] = [];
    let chunkCursor: unknown = this.job.cursor.graph ?? null;

    const flush = async (): Promise<void> => {
      if (chunk.length > 0) {
        const resolved = await this.deps.oxy.resolveGraph(chunk);
        for (const account of chunk) {
          const userId = resolved.get(account.actor);
          if (account.relation === 'block') {
            blocksRead++;
            if (userId) blockIds.push(userId);
            continue;
          }
          this.counters.followsRead++;
          if (userId) {
            followIds.push(userId);
            this.counters.followsResolved++;
          }
        }
      }
      chunk = [];
      const blocks = toFollowBatches(blockIds);
      await this.save({
        plan: {
          ...this.job.plan,
          graph: {
            followBatches: toFollowBatches(followIds),
            unresolved: this.counters.followsRead - this.counters.followsResolved,
            hidden: false,
          },
          blocks: blocksRead > 0 ? { blockBatches: blocks, read: blocksRead, unresolved: blocksRead - blocks.flat().length } : null,
        },
        cursor: { ...this.job.cursor, graph: chunkCursor },
      });
    };

    for await (const { value, cursor } of source.graph({ cursor: (this.job.cursor.graph ?? null) as never, options: this.job.options })) {
      chunk.push(value);
      chunkCursor = cursor;
      if (chunk.length >= GRAPH_CHUNK) await flush();
    }
    await flush();
    await this.save({ phases: { ...this.job.phases, graph: { status: 'done' } } });
  }

  /** Learn which of `sourceIds` an earlier run of this job delivered, in one query. */
  private async loadDelivered(sourceIds: string[]): Promise<void> {
    const unknown = [...new Set(sourceIds)].filter((id) => !this.delivered.has(id));
    if (unknown.length === 0) return;
    const rows = await this.deps.db
      .select({ sourceId: migrationItems.sourceId })
      .from(migrationItems)
      .where(and(
        eq(migrationItems.jobId, this.job.id),
        inArray(migrationItems.sourceId, unknown),
        inArray(migrationItems.status, ['sent', 'existing']),
      ));
    for (const row of rows) this.delivered.add(row.sourceId);
  }

  /**
   * Whether a reference of `item` is neither delivered in this job nor in
   * `present` (items going out EARLIER in the same send — Mention resolves a
   * parent sent earlier in the batch). Call {@link loadDelivered} first.
   */
  private isWaiting(item: SourceItem, present: ReadonlySet<string>): boolean {
    return references(item).some((reference) => !present.has(reference) && !this.delivered.has(reference));
  }

  /**
   * Store `item` as `deferred` with its payload, so it can be resent without
   * re-reading the source. An item already delivered is never demoted.
   */
  private async defer(db: Pick<Database, 'insert'>, item: SourceItem, reason: string | null): Promise<void> {
    await db
      .insert(migrationItems)
      .values({
        jobId: this.job.id,
        sourceId: item.sourceId,
        kind: item.kind,
        status: 'deferred',
        lastError: reason,
        sourceCreatedAt: new Date(item.createdAt),
        payload: item,
      })
      .onConflictDoUpdate({
        target: [migrationItems.jobId, migrationItems.sourceId],
        set: { status: 'deferred', lastError: reason, payload: item, attempts: sql`${migrationItems.attempts} + 1`, updatedAt: this.now() },
        setWhere: notInArray(migrationItems.status, ['sent', 'existing']),
      });
  }

  /**
   * Copy an item's media into Oxy, REUSING any asset a previous attempt already
   * uploaded. Each upload is recorded on the item's `migration_items` row
   * (`media_assets`, url → Oxy asset id) BEFORE the batch is sent, so a crash
   * between upload and delivery never uploads the same file twice.
   */
  private async prepare(item: SourceItem, known: Record<string, string>): Promise<PreparedItem> {
    const assets: Record<string, string> = { ...known };
    const media: PreparedItem['media'] = [];
    for (const entry of item.media) {
      const reused = assets[entry.url];
      if (reused) {
        media.push({ ...entry, assetId: reused });
        continue;
      }
      const [copied] = await this.deps.media.copy(this.job.oxyUserId, [entry]);
      if (!copied) continue;
      this.counters.mediaUploaded++;
      assets[entry.url] = copied.assetId;
      media.push(copied);
      await this.deps.db
        .insert(migrationItems)
        .values({
          jobId: this.job.id,
          sourceId: item.sourceId,
          kind: item.kind,
          status: 'pending',
          sourceCreatedAt: new Date(item.createdAt),
          mediaAssets: assets,
        })
        .onConflictDoUpdate({
          target: [migrationItems.jobId, migrationItems.sourceId],
          set: { mediaAssets: assets, updatedAt: this.now() },
        });
      // Also the heartbeat: a job copying a long run of media stays visibly
      // alive to the stalled sweep, and a cancel is observed between uploads.
      await this.save();
    }
    return { ...item, media };
  }

  /** Copy media, deliver, record results and the checkpoint in one transaction. */
  private async deliver(items: SourceItem[], contentCursor: unknown, advanceCursor: boolean): Promise<DeliveryResult[]> {
    if (items.length === 0) {
      if (advanceCursor) await this.save({ cursor: { ...this.job.cursor, content: contentCursor } });
      return [];
    }
    const rows = await this.deps.db
      .select({ sourceId: migrationItems.sourceId, mediaAssets: migrationItems.mediaAssets })
      .from(migrationItems)
      .where(and(eq(migrationItems.jobId, this.job.id), inArray(migrationItems.sourceId, items.map((item) => item.sourceId))));
    const knownAssets = new Map(rows.map((row) => [row.sourceId, row.mediaAssets ?? {}]));
    const prepared: PreparedItem[] = [];
    for (const item of items) prepared.push(await this.prepare(item, knownAssets.get(item.sourceId) ?? {}));
    const results = await this.deps.destination.deliver({
      oxyUserId: this.job.oxyUserId,
      platform: this.job.platform,
      batchId: this.job.id,
      items: prepared,
    });
    await this.record(items, results, advanceCursor ? contentCursor : undefined);
    return results;
  }

  private async record(items: SourceItem[], results: DeliveryResult[], contentCursor: unknown): Promise<void> {
    const byId = new Map(items.map((item) => [item.sourceId, item]));
    const now = this.now();
    await this.deps.db.transaction(async (tx) => {
      for (const result of results) {
        const item = byId.get(result.sourceId);
        if (!item) continue;
        if (result.status === 'deferred') {
          // Mention wrote nothing: its reply/quote target is not imported yet.
          // Keep the mapped item and resend it once the target lands.
          this.counters.deferred++;
          await this.defer(tx, item, result.error ?? null);
          continue;
        }
        const status = result.status === 'created' ? 'sent' : result.status;
        if (status === 'sent') this.counters.created++;
        else if (status === 'existing') this.counters.existing++;
        else this.counters.failed++;
        if (status !== 'failed') this.delivered.add(result.sourceId);
        await tx
          .insert(migrationItems)
          .values({
            jobId: this.job.id,
            sourceId: result.sourceId,
            kind: item.kind,
            status,
            destinationId: result.destinationId ?? null,
            attempts: 1,
            lastError: result.error ?? null,
            sourceCreatedAt: new Date(item.createdAt),
            payload: null,
          })
          .onConflictDoUpdate({
            target: [migrationItems.jobId, migrationItems.sourceId],
            set: {
              status,
              destinationId: result.destinationId ?? null,
              attempts: sql`${migrationItems.attempts} + 1`,
              lastError: result.error ?? null,
              payload: null,
              updatedAt: now,
            },
          });
      }
      const rows = await tx
        .update(migrationJobs)
        .set({
          counters: this.counters,
          ...(contentCursor !== undefined ? { cursor: { ...this.job.cursor, content: contentCursor } } : {}),
          updatedAt: now,
        })
        .where(and(eq(migrationJobs.id, this.job.id), inArray(migrationJobs.status, [...ACTIVE_JOB_STATUSES])))
        .returning();
      if (rows.length === 0) throw new JobCancelledError();
      this.job = rows[0];
    });
    this.deps.progress.emit(this.job.oxyUserId, this.job);
  }

  private async contentPhase(source: Source): Promise<void> {
    await this.setPhase('content', 'running');
    const max = this.deps.destination.maxBatchSize;
    let pending: SourceItem[] = [];
    let lastCursor: unknown = this.job.cursor.content ?? null;
    let sinceCheckpoint = 0;

    for await (const { value, cursor } of source.items({ cursor: (this.job.cursor.content ?? null) as never, options: this.job.options })) {
      this.counters.read++;
      lastCursor = cursor;
      sinceCheckpoint++;
      if (isSkipped(value)) {
        this.counters.skipped++;
      } else {
        // Sources read newest first, so a child usually arrives before its
        // parent: hold it back locally instead of letting Mention defer it.
        await this.loadDelivered(references(value));
        if (this.isWaiting(value, new Set(pending.map((item) => item.sourceId)))) {
          await this.defer(this.deps.db, value, null);
          this.counters.deferred++;
        } else {
          pending.push(value);
        }
      }
      if (pending.length >= max) {
        await this.deliver(pending, lastCursor, true);
        pending = [];
        sinceCheckpoint = 0;
      } else if (pending.length === 0 && sinceCheckpoint >= CHECKPOINT_EVERY) {
        await this.deliver([], lastCursor, true);
        sinceCheckpoint = 0;
      }
    }
    await this.deliver(pending, lastCursor, true);
    await this.deferredPass(max);
    this.counters.deferred = 0;
    await this.save({ phases: { ...this.job.phases, content: { status: 'done' } } });
  }

  private async deferredRows(): Promise<SourceItem[]> {
    const rows = await this.deps.db
      .select({ payload: migrationItems.payload })
      .from(migrationItems)
      .where(and(eq(migrationItems.jobId, this.job.id), eq(migrationItems.status, 'deferred')))
      .orderBy(asc(migrationItems.sourceCreatedAt), asc(migrationItems.sourceId));
    return rows.map((row) => row.payload as SourceItem);
  }

  private async sendInBatches(items: SourceItem[], max: number): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    // Oldest first; Mention resolves a parent sent earlier in the same batch.
    for (let start = 0; start < items.length; start += max) {
      results.push(...(await this.deliver(items.slice(start, start + max), undefined, false)));
    }
    return results;
  }

  /**
   * Resend deferred items once their targets land, in waves, oldest first.
   *
   * When no deferred item is ready any more, what is left references a post
   * this job will never deliver (skipped, filtered, deleted at the source, or
   * imported by an EARLIER job). Mention's lookup separates the last case —
   * those are sent WITH the reference, which Mention resolves across batches —
   * from the rest, which are sent STANDALONE: the reference is dropped and a
   * link to the original target is added, so nothing stays deferred forever and
   * no item is ever sent with a reference Mention cannot resolve.
   */
  private async deferredPass(max: number): Promise<void> {
    // Every wave that continues moves at least one item out of `deferred`, so
    // this ends; a wave with nothing ready, or where Mention deferred all it was
    // sent, falls through to the final resolution.
    for (;;) {
      const deferred = await this.deferredRows();
      if (deferred.length === 0) return;
      await this.loadDelivered(deferred.flatMap(references));
      // Oldest first, so a parent precedes its children and can go out in the same send.
      const ready: SourceItem[] = [];
      const readyIds = new Set<string>();
      for (const item of deferred) {
        if (!this.isWaiting(item, readyIds)) {
          ready.push(item);
          readyIds.add(item.sourceId);
        }
      }
      if (ready.length > 0) {
        const results = await this.sendInBatches(ready, max);
        if (results.some((result) => result.status !== 'deferred')) continue;
      }
      await this.resolveOrphans(await this.deferredRows(), max);
      return;
    }
  }

  private async resolveOrphans(orphans: SourceItem[], max: number): Promise<void> {
    if (orphans.length === 0) return;
    const referenced = [...new Set(orphans.flatMap(references))];
    const known = await this.deps.destination.lookupImported({
      oxyUserId: this.job.oxyUserId,
      platform: this.job.platform,
      sourceIds: referenced,
    });
    const prepared = orphans.map((item) => standalone(item, (reference) => known.has(reference) || this.delivered.has(reference)));
    const results = await this.sendInBatches(prepared, max);
    // A lookup/insert race can still defer one: send those with no references at all.
    const stillDeferred = new Set(results.filter((result) => result.status === 'deferred').map((result) => result.sourceId));
    if (stillDeferred.size > 0) {
      await this.sendInBatches(prepared.filter((item) => stillDeferred.has(item.sourceId)).map((item) => standalone(item, () => false)), max);
    }
  }
}

/** The source ids an item points at (its reply parent and quoted post). */
function references(item: SourceItem): string[] {
  return [item.replyToSourceId, item.quoteSourceId].filter((value): value is string => Boolean(value));
}

/** The web URL of a referenced source post, for the link a standalone import carries. */
function referenceUrl(sourceId: string): string | undefined {
  if (/^https?:\/\//i.test(sourceId)) return sourceId;
  const at = sourceId.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  return at ? `https://bsky.app/profile/${at[1]}/post/${at[2]}` : undefined;
}

/**
 * The item with every reference `keep` rejects removed and replaced by a link to
 * the original target, so it imports as a standalone post.
 */
function standalone(item: SourceItem, keep: (reference: string) => boolean): SourceItem {
  const links = [...(item.links ?? [])];
  const out: SourceItem = { ...item };
  for (const key of ['replyToSourceId', 'quoteSourceId'] as const) {
    const reference = item[key];
    if (!reference || keep(reference)) continue;
    delete out[key];
    const url = referenceUrl(reference);
    if (url && !links.includes(url)) links.push(url);
  }
  if (links.length > 0) out.links = links;
  return out;
}

async function loadJob(db: Database, jobId: string): Promise<MigrationJob | undefined> {
  const rows = await db.select().from(migrationJobs).where(eq(migrationJobs.id, jobId));
  return rows[0];
}

/**
 * Run a job until it finishes, pauses, fails permanently, is cancelled, or hits
 * a transient error (returned as `retry` so the queue re-attempts it).
 */
export async function runMigrationJob(jobId: string, deps: PipelineDeps): Promise<RunOutcome> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { status: 'missing' };
  if (!(ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status)) {
    return { status: job.status as 'done' | 'failed' | 'cancelled' | 'undone' };
  }
  const now = deps.now ?? (() => new Date());
  const run = new JobRun(job, deps);
  try {
    await run.run();
    return { status: 'done' };
  } catch (error) {
    const coded = (error as { moveCode?: string } | null)?.moveCode;
    const disposition: Disposition = coded === 'linked-account-changed'
      ? { kind: 'fail', code: 'linked-account-changed' }
      : classify(error);
    switch (disposition.kind) {
      case 'cancelled': {
        // An undo that raced a delivery already in flight: Mention may have
        // created that batch AFTER the undo's delete. Deleting the batch again is
        // idempotent and closes the window.
        const latest = await loadJob(deps.db, jobId);
        if (latest?.status === 'undone') {
          await deps.destination.undo({ oxyUserId: latest.oxyUserId, batchId: latest.id }).catch((undoError) => {
            logger.warn('[pipeline] post-undo batch delete failed', undoError);
          });
          return { status: 'undone' };
        }
        return { status: 'cancelled' };
      }
      case 'pause': {
        const resumeAt = new Date(now().getTime() + disposition.retryAfterMs);
        await deps.db
          .update(migrationJobs)
          .set({ status: 'paused', pausedUntil: resumeAt, updatedAt: now() })
          .where(and(eq(migrationJobs.id, jobId), inArray(migrationJobs.status, [...ACTIVE_JOB_STATUSES])));
        emitLatest(deps, jobId);
        return { status: 'paused', resumeAt };
      }
      case 'fail':
        await failJob(deps, jobId, disposition.code, disposition.detail);
        return { status: 'failed' };
      default:
        logger.warn('[pipeline] transient failure; the attempt will be retried from the last checkpoint', error);
        return { status: 'retry', error };
    }
  }
}

function emitLatest(deps: PipelineDeps, jobId: string): void {
  void loadJob(deps.db, jobId).then((job) => {
    if (job) deps.progress.emit(job.oxyUserId, job);
  }).catch(() => undefined);
}

/** Mark a job failed (only while active) with a stable code. */
export async function failJob(deps: Pick<PipelineDeps, 'db' | 'progress' | 'now'>, jobId: string, code: string, detail?: string): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const rows = await deps.db
    .update(migrationJobs)
    .set({ status: 'failed', error: detail ? `${code}: ${detail}` : code, finishedAt: now(), updatedAt: now() })
    .where(and(eq(migrationJobs.id, jobId), inArray(migrationJobs.status, [...ACTIVE_JOB_STATUSES])))
    .returning();
  if (rows[0]) deps.progress.emit(rows[0].oxyUserId, rows[0]);
}
