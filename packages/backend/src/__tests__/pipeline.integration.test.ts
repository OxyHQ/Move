/**
 * The pipeline end to end, against a REAL Postgres and the REAL Mastodon source
 * (replaying recorded responses), with Mention and Oxy replaced by in-memory
 * fakes that implement their contracts. What is under test is Move's own
 * behaviour: checkpoints, pause/resume, deferral order, idempotence, undo and
 * ownership.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { MIGRATION_PLATFORMS } from '@move/shared-types';
import type { ServiceLinkedAccount, ServiceLinkedAccountListResponse } from '@oxy.so/contracts';
import { migrationItems, migrationJobs, type MigrationJob } from '../db/schema';
import { MastodonSource } from '../sources/mastodon';
import { BlueskySource } from '../sources/bluesky';
import { createMediaCopier, createMemoryUploadLimiter } from '../destinations/media';
import { ForeignLinkedAccountError, OxyGateway, type OxyServiceClient } from '../destinations/oxy';
import {
  DestinationRateLimitedError,
  type ContentDestination,
  type DeliveryResult,
  type PreparedItem,
} from '../destinations/types';
import { OxyUploadError } from '../utils/oxyHelpers';
import { runMigrationJob, type PipelineDeps, type ProgressSink } from '../pipeline/runner';
import { JobConflictError, JobService } from '../pipeline/jobService';
import { processMigrationMessage } from '../queue/workers';
import {
  BSKY_PDS,
  GARGRON,
  JAY_DID,
  blueskyRoutes,
  createFixtureFetcher,
  mastodonRoutes,
  type FixtureFetcher,
} from './helpers/fixtureFetcher';
// The CLIENT's plan applier, run against the real JobService: undo on another
// device must work from what the backend recorded, and only a test that drives
// both halves together can show it.
import { applyPlan, undoPlan, type PlanApi, type PlanSdk, type ProfileUpdate } from '../../../frontend/lib/planApplier';
import { createTestDatabase, type TestDatabase } from './helpers/testDatabase';

const STATUS = (id: string) => `${GARGRON}/statuses/${id}`;
/** Every item the default options import from the recorded outbox. */
const EXPECTED_IMPORTS = [
  '117330917869779654', // self-quote (deferred behind its target)
  '117327932994028225',
  '117294179974600212', // self-reply (deferred behind its parent on page 2)
  '1172759643453271019', // synthetic CW
  '117275979075957026',
  '117293597728332882', // media
  '117254912647958576',
].map(STATUS);

type FailMode = 'none' | 'rate-limit' | 'transient' | 'lose-response';

/**
 * Mention's ingest semantics as its PostImportService implements them: a
 * repeated (user, platform, sourceId) answers `existing`; a reply/quote whose
 * target this user has not imported from this platform (in any batch, or
 * earlier in this one) answers `deferred` and writes NOTHING; undo reports
 * `{ deleted, failed }`.
 */
class FakeMention implements ContentDestination {
  readonly name = 'mention' as const;
  posts = new Map<string, { postId: string; batchId: string; item: PreparedItem }>();
  received: string[] = [];
  deliveries = 0;
  failOnDelivery = new Map<number, FailMode>();
  /** Posts the next undo fails to delete. */
  undoFailures = 0;
  lookups: string[][] = [];
  /** Every sourceId Mention answered `deferred` (sent with a reference it could not resolve). */
  deferredAnswers: string[] = [];
  constructor(readonly maxBatchSize = 50) {}

  private key(user: string, platform: string, sourceId: string): string {
    return `${user}|${platform}|${sourceId}`;
  }

  async deliver(params: { oxyUserId: string; platform: 'mastodon' | 'bluesky'; batchId: string; items: PreparedItem[] }): Promise<DeliveryResult[]> {
    this.deliveries++;
    const mode = this.failOnDelivery.get(this.deliveries) ?? 'none';
    if (mode === 'rate-limit') throw new DestinationRateLimitedError('slow down', 30_000);
    if (mode === 'transient') throw new Error('Mention POST answered 503');
    const results: DeliveryResult[] = params.items.map((item) => {
      const key = this.key(params.oxyUserId, params.platform, item.sourceId);
      const existing = this.posts.get(key);
      if (existing) return { sourceId: item.sourceId, status: 'existing', destinationId: existing.postId };
      if (item.replyToSourceId && !this.posts.has(this.key(params.oxyUserId, params.platform, item.replyToSourceId))) {
        this.deferredAnswers.push(item.sourceId);
        return { sourceId: item.sourceId, status: 'deferred', error: 'parent_not_imported' };
      }
      if (item.quoteSourceId && !this.posts.has(this.key(params.oxyUserId, params.platform, item.quoteSourceId))) {
        this.deferredAnswers.push(item.sourceId);
        return { sourceId: item.sourceId, status: 'deferred', error: 'quote_not_imported' };
      }
      const postId = randomUUID();
      this.posts.set(key, { postId, batchId: params.batchId, item });
      this.received.push(item.sourceId);
      return { sourceId: item.sourceId, status: 'created', destinationId: postId };
    });
    if (mode === 'lose-response') throw new Error('socket hang up after Mention committed');
    return results;
  }

  async undo(params: { oxyUserId: string; batchId: string }): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    for (const [key, post] of this.posts) {
      if (post.batchId !== params.batchId) continue;
      if (failed < this.undoFailures) {
        failed++;
        continue;
      }
      this.posts.delete(key);
      deleted++;
    }
    this.undoFailures = 0;
    return { deleted, failed };
  }

  async lookupImported(params: { oxyUserId: string; platform: 'mastodon' | 'bluesky'; sourceIds: string[] }): Promise<Set<string>> {
    this.lookups.push(params.sourceIds);
    return new Set(params.sourceIds.filter((id) => this.posts.has(this.key(params.oxyUserId, params.platform, id))));
  }
}

class FakeOxy {
  linkedAccounts: Array<ServiceLinkedAccount & { ownerId: string }> = [];
  notifications: Array<Record<string, unknown>> = [];
  readonly client = {
    getLinkedAccountsForUser: async (userId: string): Promise<ServiceLinkedAccountListResponse> => ({
      userId,
      linkedAccounts: this.linkedAccounts.filter((account) => account.ownerId === userId).map(({ ownerId: _, ...account }) => account),
    }),
    makeServiceRequest: async <R,>(method: string, path: string, body?: unknown): Promise<R> => (await this.serviceRequest(method, path, body)) as R,
  } satisfies OxyServiceClient;
  private async serviceRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    if (method === 'POST' && path === '/federation/identities/lookup') {
      const identifiers = (body as { identifiers: string[] }).identifiers;
      // Oxy already knows every other account; the rest need a resolve.
      return { identities: identifiers.map((identifier, index) => ({ identifier, userId: index % 2 === 0 ? `oxy-${identifier.length}-${index}` : null })) };
    }
    if (method === 'POST' && path === '/federation/identities/resolve') {
      const actorUri = (body as { actorUri: string }).actorUri;
      // DIDs all have one length, so they get an id of their own.
      return { user: { id: actorUri.startsWith('did:') ? `oxy-${actorUri}` : `oxy-resolved-${actorUri.length}` } };
    }
    if (method === 'POST' && path === '/notifications') {
      this.notifications.push(body as Record<string, unknown>);
      return {};
    }
    throw new Error(`unexpected Oxy call ${method} ${path}`);
  }
}

const USER = 'user-1';
const LINKED = 'la-1';
const LINKED_BSKY = 'la-bsky';

let database: TestDatabase;
let mention: FakeMention;
let oxy: FakeOxy;
let fetcher: FixtureFetcher;
let uploads: number;
let uploadFailures: number[];
let deps: PipelineDeps;
let jobs: JobService;
let enqueued: string[];
/** The upload limiter's clock, so a test can let a 429 block expire. */
let clock = Date.now();
const emitted: MigrationJob[] = [];
const progress: ProgressSink = { emit: (_user, job) => emitted.push(job) };

function build(maxBatchSize = 50): void {
  mention = new FakeMention(maxBatchSize);
  fetcher = createFixtureFetcher(mastodonRoutes());
  uploads = 0;
  deps = {
    db: database.db,
    oxy: new OxyGateway(oxy.client),
    destination: mention,
    media: createMediaCopier({
      limiter: createMemoryUploadLimiter(100, () => clock),
      download: async () => ({ buffer: Buffer.from('jpeg-bytes'), contentType: 'image/jpeg' }),
      upload: async () => {
        uploads++;
        if (uploadFailures.includes(uploads)) throw new OxyUploadError('Too many uploads', 429, '90');
        return { fileId: `file-${uploads}` };
      },
      sleep: async () => undefined,
    }),
    sourceFactory: async (account) =>
      account.platform === 'bluesky'
        ? new BlueskySource(account, createFixtureFetcher(blueskyRoutes()), { pdsEndpoint: BSKY_PDS })
        : new MastodonSource(account, fetcher),
    progress,
  };
  enqueued = [];
  jobs = new JobService({
    db: deps.db,
    oxy: deps.oxy,
    destination: deps.destination,
    sourceFactory: deps.sourceFactory,
    progress,
    enqueue: async (jobId) => { enqueued.push(jobId); },
  });
}

async function job(id: string): Promise<MigrationJob> {
  const rows = await database.db.select().from(migrationJobs).where(eq(migrationJobs.id, id));
  return rows[0];
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await database.db.delete(migrationJobs);
  oxy = new FakeOxy();
  const linked = { proofMethod: 'oauth' as const, verifiedAt: '2026-09-25T00:00:00.000Z', createdAt: '2026-09-25T00:00:00.000Z', federatedUserId: null };
  oxy.linkedAccounts = [{
    ownerId: USER,
    id: LINKED,
    network: 'activitypub' as const,
    accountKey: 'Gargron@mastodon.social',
    actorUri: GARGRON,
    handle: 'Gargron',
    host: 'mastodon.social',
    ...linked,
  }, {
    ownerId: USER,
    id: LINKED_BSKY,
    network: 'atproto' as const,
    accountKey: JAY_DID,
    actorUri: JAY_DID,
    handle: 'jay.bsky.team',
    host: 'bsky.social',
    ...linked,
  }];
  uploadFailures = [];
  build();
});

describe('migration pipeline (real Postgres, Mention and Oxy faked)', () => {
  test('a full run imports every public own post, parents before children, and plans profile + graph', async () => {
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    expect(enqueued).toEqual([created.id]);
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });

    expect([...mention.received].sort()).toEqual([...EXPECTED_IMPORTS].sort());
    const order = mention.received;
    expect(order.indexOf(STATUS('117293597728332882'))).toBeLessThan(order.indexOf(STATUS('117294179974600212')));
    expect(order.indexOf(STATUS('117327932994028225'))).toBeLessThan(order.indexOf(STATUS('117330917869779654')));

    const done = await job(created.id);
    expect(done.status).toBe('done');
    expect(done.counters.created).toBe(EXPECTED_IMPORTS.length);
    expect(done.counters.skipped).toBeGreaterThan(0);
    expect(done.phases).toEqual({ profile: { status: 'done' }, graph: { status: 'done' }, content: { status: 'done' } });
    expect(done.plan.profile?.displayName).toBe('Eugen Rochko');
    expect(done.plan.profile?.avatarFileId).toStartWith('file-');
    expect(done.plan.graph?.followBatches.flat().length).toBe(5);
    expect(done.plan.graph?.unresolved).toBe(0);
    expect(oxy.notifications).toHaveLength(1);
    expect(oxy.notifications[0]).toMatchObject({
      recipientId: USER,
      type: 'system',
      entityId: created.id,
      entityType: 'app',
      url: `https://move.oxy.so/jobs/${created.id}`,
    });
    const note = oxy.notifications[0] as { title: string; message: string; data: Record<string, unknown> };
    expect(note.title.length).toBeLessThanOrEqual(120);
    expect(note.message.length).toBeLessThanOrEqual(500);
    expect(note.data.url).toBeUndefined();

    const media = [...mention.posts.values()].find((post) => post.item.sourceId === STATUS('117293597728332882'));
    expect(media?.item.media[0].assetId).toStartWith('file-');

    const items = await database.db.select().from(migrationItems).where(eq(migrationItems.jobId, created.id));
    expect(items.filter((item) => item.status === 'sent')).toHaveLength(EXPECTED_IMPORTS.length);
    expect(items.every((item) => item.payload === null)).toBe(true);
    expect(emitted.length).toBeGreaterThan(0);
  });

  test('an Oxy 429 on media pauses the job (never fails it) and the next run resumes to done', async () => {
    uploadFailures = [2]; // the post image, after the avatar
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    const first = await runMigrationJob(created.id, deps);
    expect(first.status).toBe('paused');
    const paused = await job(created.id);
    expect(paused.status).toBe('paused');
    expect(paused.error).toBeNull();
    expect(paused.pausedUntil!.getTime()).toBeGreaterThan(Date.now() + 60_000);

    // The worker turns the pause into a delayed message, not a failure.
    const rescheduled: Array<[string, number]> = [];
    await processMigrationMessage({ data: { jobId: created.id }, attemptsMade: 0 }, deps, async (id, delay) => { rescheduled.push([id, delay]); });
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0][1]).toBeGreaterThan(60_000);

    // Oxy's 429 blocked the whole limiter for its Retry-After (90 s): the run the
    // worker just made paused again instead of hammering Oxy. Once it expires,
    // the job completes.
    clock += 120_000;
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });
    expect([...mention.received].sort()).toEqual([...EXPECTED_IMPORTS].sort());
  });

  test('a hidden follow list is recorded with the profile, so the graph is never read', async () => {
    const routes = mastodonRoutes();
    routes[`${GARGRON}/following`] = { type: 'OrderedCollection', totalItems: 5 };
    fetcher = createFixtureFetcher(routes);
    deps.sourceFactory = async (account) => {
      const source = new MastodonSource(account, fetcher);
      source.graph = () => { throw new Error('the graph of a hidden follow list was read'); };
      return source;
    };
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });
    const done = await job(created.id);
    expect(done.phases.graph).toEqual({ status: 'skipped', reason: 'hidden' });
    expect(done.plan.graph).toEqual({ followBatches: [], unresolved: 0, hidden: true });
  });

  test('a Mention 429 also pauses', async () => {
    mention.failOnDelivery.set(1, 'rate-limit');
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    expect((await runMigrationJob(created.id, deps)).status).toBe('paused');
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });
    expect(mention.received).toHaveLength(EXPECTED_IMPORTS.length);
  });

  test('a transient failure resumes from the saved cursor, not from the start', async () => {
    build(2);
    mention.failOnDelivery.set(2, 'transient');
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    const first = await runMigrationJob(created.id, deps);
    expect(first.status).toBe('retry');
    const afterFirst = await job(created.id);
    expect(afterFirst.cursor.content).toMatchObject({ pageUrl: `${GARGRON}/outbox?page=true` });
    expect(afterFirst.counters.created).toBe(2);

    const callsBefore = fetcher.calls.length;
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });
    // The resumed run went straight to the checkpointed page: the outbox head
    // (the "start from the beginning" request) was not fetched again.
    expect(fetcher.calls.slice(callsBefore)).not.toContain(`${GARGRON}/outbox`);
    expect([...mention.received].sort()).toEqual([...EXPECTED_IMPORTS].sort());
    expect(new Set(mention.received).size).toBe(mention.received.length);
  });

  test('a lost response is resent idempotently: nothing is duplicated', async () => {
    mention.failOnDelivery.set(1, 'lose-response');
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    expect((await runMigrationJob(created.id, deps)).status).toBe('retry');
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });
    expect(mention.posts.size).toBe(EXPECTED_IMPORTS.length);
    // Avatar + the one post image: the retry REUSED the image uploaded before
    // the lost response (recorded on migration_items first), not a copy.
    expect(uploads).toBe(2);
    const done = await job(created.id);
    expect(done.counters.existing).toBeGreaterThan(0);
    expect(done.counters.created + done.counters.existing).toBeGreaterThanOrEqual(EXPECTED_IMPORTS.length);
  });

  test('a self-reply whose parent never arrives imports STANDALONE with a link to the parent', async () => {
    const routes = mastodonRoutes();
    const page2 = routes[`${GARGRON}/outbox?max_id=117293597728332883&page=true`] as { orderedItems: unknown[] };
    routes[`${GARGRON}/outbox?max_id=117293597728332883&page=true`] = { ...page2, orderedItems: page2.orderedItems.slice(1) };
    fetcher = createFixtureFetcher(routes);
    deps.sourceFactory = async (account) => new MastodonSource(account, fetcher);

    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });
    const reply = [...mention.posts.values()].find((post) => post.item.sourceId === STATUS('117294179974600212'));
    expect(reply).toBeDefined();
    expect(reply!.item.replyToSourceId).toBeUndefined();
    expect(reply!.item.links).toContain(STATUS('117293597728332882'));
    // It was never sent with a reference Mention could not resolve.
    expect(mention.deferredAnswers).not.toContain(STATUS('117294179974600212'));
    const items = await database.db.select().from(migrationItems).where(eq(migrationItems.jobId, created.id));
    expect(items.filter((item) => item.status === 'deferred')).toHaveLength(0);
    expect((await job(created.id)).counters.deferred).toBe(0);
  });

  test('a parent imported by an EARLIER job is kept as the reply target (lookup, not standalone)', async () => {
    const routes = mastodonRoutes();
    const page2 = routes[`${GARGRON}/outbox?max_id=117293597728332883&page=true`] as { orderedItems: unknown[] };
    routes[`${GARGRON}/outbox?max_id=117293597728332883&page=true`] = { ...page2, orderedItems: page2.orderedItems.slice(1) };
    fetcher = createFixtureFetcher(routes);
    deps.sourceFactory = async (account) => new MastodonSource(account, fetcher);
    const parent = STATUS('117293597728332882');
    mention.posts.set(`${USER}|mastodon|${parent}`, { postId: 'earlier-post', batchId: 'earlier-job', item: {} as PreparedItem });

    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });
    const reply = [...mention.posts.values()].find((post) => post.item.sourceId === STATUS('117294179974600212'));
    expect(reply!.item.replyToSourceId).toBe(parent);
    expect(mention.lookups.flat()).toContain(parent);
  });

  test('an item Mention answers `deferred` is kept and resent, never counted as failed', async () => {
    // Mention knows nothing Move delivered in its FIRST request (as if its
    // ledger lagged): the self-quote and self-reply come back `deferred`.
    const original = mention.deliver.bind(mention);
    let calls = 0;
    mention.deliver = async (params) => {
      calls++;
      if (calls === 2) {
        return params.items.map((item) => ({ sourceId: item.sourceId, status: 'deferred' as const, error: 'parent_not_imported' }));
      }
      return original(params);
    };
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    expect(await runMigrationJob(created.id, deps)).toEqual({ status: 'done' });
    expect([...mention.received].sort()).toEqual([...EXPECTED_IMPORTS].sort());
    const done = await job(created.id);
    expect(done.counters.failed).toBe(0);
    expect(done.counters.deferred).toBe(0);
  });

  test('undo surfaces the posts Mention failed to delete, and a second undo retries them', async () => {
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    await runMigrationJob(created.id, deps);
    mention.undoFailures = 2;
    const first = await jobs.undo(USER, created.id);
    expect(first).toMatchObject({ deleted: EXPECTED_IMPORTS.length - 2, failed: 2 });
    expect(first.job.status).toBe('undone');
    expect(first.job.undoResult).toEqual({ deleted: EXPECTED_IMPORTS.length - 2, failed: 2 });
    const second = await jobs.undo(USER, created.id);
    expect(second).toMatchObject({ deleted: 2, failed: 0 });
    expect(second.job.undoResult).toEqual({ deleted: EXPECTED_IMPORTS.length, failed: 0 });
    expect(mention.posts.size).toBe(0);
  });

  test('undo deletes Mention\'s batch, marks items undone and returns the plan for the client', async () => {
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    await runMigrationJob(created.id, deps);
    expect(mention.posts.size).toBe(EXPECTED_IMPORTS.length);
    const result = await jobs.undo(USER, created.id);
    expect(result.deleted).toBe(EXPECTED_IMPORTS.length);
    expect(mention.posts.size).toBe(0);
    expect(result.job.status).toBe('undone');
    expect(result.plan.graph?.followBatches.flat()).toHaveLength(5);
    const items = await database.db.select().from(migrationItems).where(eq(migrationItems.jobId, created.id));
    expect(items.every((item) => item.status === 'undone')).toBe(true);
    // Idempotent: a second undo deletes nothing and does not throw.
    expect((await jobs.undo(USER, created.id)).deleted).toBe(0);
  });

  test('a linked account that is not the caller\'s is rejected before any job exists', async () => {
    await expect(jobs.create('someone-else', { platform: 'mastodon', linkedAccountId: LINKED })).rejects.toBeInstanceOf(ForeignLinkedAccountError);
    await expect(jobs.create(USER, { platform: 'bluesky', linkedAccountId: LINKED })).rejects.toBeInstanceOf(ForeignLinkedAccountError);
    expect(await database.db.select().from(migrationJobs)).toHaveLength(0);
  });

  test('a linked account revoked after creation fails the run with a stable code', async () => {
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    oxy.linkedAccounts = [];
    expect((await runMigrationJob(created.id, deps)).status).toBe('failed');
    expect((await job(created.id)).error).toBe('linked-account-not-owned');
    expect(mention.received).toHaveLength(0);
  });

  test('at most one active job per user and platform, enforced by the database', async () => {
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    await expect(jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED })).rejects.toBeInstanceOf(JobConflictError);
    await runMigrationJob(created.id, deps);
    // Finished jobs are history; they do not hold the slot. A second finished
    // migration notifies under its OWN entity id (Oxy dedupes on entityId).
    const second = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    await runMigrationJob(second.id, deps);
    expect(oxy.notifications.map((note) => note.entityId)).toEqual([created.id, second.id]);
    expect(MIGRATION_PLATFORMS).toContain('mastodon');
  });

  test('a cancelled job is never run', async () => {
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    await jobs.cancel(USER, created.id);
    expect((await runMigrationJob(created.id, deps)).status).toBe('cancelled');
    expect(mention.received).toHaveLength(0);
  });

  test('another user cannot read, cancel or undo a job', async () => {
    const created = await jobs.create(USER, { platform: 'mastodon', linkedAccountId: LINKED });
    await expect(jobs.get('intruder', created.id)).rejects.toThrow('job not found');
    await expect(jobs.cancel('intruder', created.id)).rejects.toThrow('job not found');
    await expect(jobs.undo('intruder', created.id)).rejects.toThrow('job not found');
  });
});

/**
 * One Oxy account as the client's SDK sees it. Every device's session writes
 * the same account, which is what makes a second device meaningful.
 */
class FakeOxyAccount {
  profile: { name: { displayName?: string }; bio?: string; avatar?: string | null; links?: string[] } = {
    name: { displayName: 'Jay before Move' },
    bio: 'bio before Move',
    avatar: 'file-before',
    links: ['https://before.example'],
  };
  following = new Set<string>();
  blocked = new Set<string>();

  session(): PlanSdk {
    return {
      getCurrentUser: async () => structuredClone(this.profile),
      updateProfile: async (update: ProfileUpdate) => {
        if (update.name) this.profile.name = { ...update.name };
        if (update.bio !== undefined) this.profile.bio = update.bio;
        if (update.avatar !== undefined) this.profile.avatar = update.avatar;
        if (update.links !== undefined) this.profile.links = update.links;
        return this.profile;
      },
      getFollowStatuses: async (ids) => Object.fromEntries(ids.map((id) => [id, this.following.has(id)])),
      followUsers: async (ids) => ids.forEach((id) => this.following.add(id)),
      unfollowUsers: async (ids) => ids.forEach((id) => this.following.delete(id)),
      getBlockedUsers: async () => [...this.blocked].map((blockedId) => ({ blockedId })),
      blockUser: async (id) => this.blocked.add(id),
      unblockUser: async (id) => this.blocked.delete(id),
    };
  }
}

describe('the client plan: resumable and undoable from any device (real JobService)', () => {
  const deviceApi = (options: { crashAfterFirstFollow?: boolean } = {}): PlanApi => {
    let crashed = false;
    return {
      plan: (id) => jobs.plan(USER, id),
      ack: async (id, ack) => {
        if (options.crashAfterFirstFollow && !crashed && ack.followBatchesApplied) {
          // The follow landed at Oxy; the app died before telling Move.
          crashed = true;
          throw new Error('app closed');
        }
        return jobs.ackPlan(USER, id, ack);
      },
    };
  };

  test('a Bluesky run plans the profile, the follows and the PUBLIC blocks', async () => {
    const created = await jobs.create(USER, { platform: 'bluesky', linkedAccountId: LINKED_BSKY });
    expect((await runMigrationJob(created.id, deps)).status).toBe('done');
    const done = await job(created.id);
    expect(done.plan.graph?.followBatches.flat()).toHaveLength(3);
    expect(done.plan.blocks).toEqual({
      blockBatches: [expect.any(Array)],
      read: 5,
      unresolved: 0,
    });
    expect(done.plan.blocks?.blockBatches[0]).toHaveLength(5);
    // Blocks are not follows: the follow counters count follows only.
    expect(done.counters.followsRead).toBe(3);
  });

  test('undo on a second device restores the profile and removes only what Move created', async () => {
    const created = await jobs.create(USER, { platform: 'bluesky', linkedAccountId: LINKED_BSKY });
    await runMigrationJob(created.id, deps);
    const { plan } = await jobs.plan(USER, created.id);
    const follows = plan.graph!.followBatches.flat();
    const blocks = plan.blocks!.blockBatches.flat();

    const account = new FakeOxyAccount();
    const original = structuredClone(account.profile);
    account.following.add(follows[0]); // the user already followed this one
    account.blocked.add(blocks[1]); // and already blocked this one

    // Device A applies the profile, follows batch 0, and dies before acking it.
    await expect(applyPlan({ api: deviceApi({ crashAfterFirstFollow: true }), sdk: account.session() }, created.id)).rejects.toThrow('app closed');
    expect(account.profile.name.displayName).toBe(plan.profile?.displayName);

    // Device B resumes. It now sees every target followed — the backend must
    // keep device A's fact, recorded BEFORE the follow, not B's re-check.
    await applyPlan({ api: deviceApi(), sdk: account.session() }, created.id);
    const facts = (await jobs.plan(USER, created.id)).undoFacts;
    expect(facts?.alreadyFollowing).toEqual({ 0: [follows[0]] });
    expect(facts?.alreadyBlocked).toEqual({ 0: [blocks[1]] });
    expect(facts?.profileBefore).toEqual({
      displayName: original.name.displayName,
      bio: original.bio,
      ...(plan.profile?.avatarFileId ? { avatar: 'file-before' } : {}),
      ...(plan.profile?.links?.length ? { links: original.links } : {}),
    });
    expect(account.following.size).toBe(3);
    expect(account.blocked.size).toBe(5);

    // Device C, with nothing of its own, undoes from what Move returns.
    const result = await jobs.undo(USER, created.id);
    const client = await undoPlan({ sdk: account.session() }, result);

    expect(client).toMatchObject({ unfollowed: 2, unblocked: 4, kept: 2, profileRestored: true, profileKept: false });
    expect([...account.following]).toEqual([follows[0]]);
    expect([...account.blocked]).toEqual([blocks[1]]);
    expect(account.profile.name.displayName).toBe(original.name.displayName);
    expect(account.profile.bio).toBe(original.bio);
    if (plan.profile?.avatarFileId) expect(account.profile.avatar).toBe('file-before');
  });

  test('the client sees no follow or block batch while the graph is still being built', async () => {
    const created = await jobs.create(USER, { platform: 'bluesky', linkedAccountId: LINKED_BSKY });
    await runMigrationJob(created.id, deps);
    const done = await job(created.id);
    await database.db
      .update(migrationJobs)
      .set({ phases: { ...done.phases, graph: { status: 'running' } } })
      .where(eq(migrationJobs.id, created.id));
    const { plan } = await jobs.plan(USER, created.id);
    expect(plan.graph).toBeNull();
    expect(plan.blocks).toBeNull();
    expect(plan.profile).toEqual(done.plan.profile);
  });

  test('the ack refuses facts that do not belong to the plan, and keeps the first of each', async () => {
    const created = await jobs.create(USER, { platform: 'bluesky', linkedAccountId: LINKED_BSKY });
    await runMigrationJob(created.id, deps);
    const { plan } = await jobs.plan(USER, created.id);
    const [first, second] = plan.graph!.followBatches[0];

    await expect(jobs.ackPlan(USER, created.id, { alreadyFollowing: { 0: ['someone-else'] } })).rejects.toThrow('outside its batch');
    await expect(jobs.ackPlan(USER, created.id, { alreadyBlocked: { 7: [] } })).rejects.toThrow('out of range');
    await expect(jobs.ackPlan(USER, created.id, { blockBatchesApplied: [1] })).rejects.toThrow('out of range');

    await jobs.ackPlan(USER, created.id, { alreadyFollowing: { 0: [first] }, profileBefore: { bio: 'first' } });
    await jobs.ackPlan(USER, created.id, { alreadyFollowing: { 0: [first, second] }, profileBefore: { bio: 'second' } });
    const facts = (await jobs.plan(USER, created.id)).undoFacts;
    expect(facts?.alreadyFollowing).toEqual({ 0: [first] });
    expect(facts?.profileBefore).toEqual({ bio: 'first' });
    await expect(jobs.ackPlan('intruder', created.id, { profileApplied: true })).rejects.toThrow('job not found');
  });
});
