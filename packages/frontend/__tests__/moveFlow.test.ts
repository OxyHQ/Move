/**
 * The client side of confirm → progress → undo, against an in-memory Move API.
 * The same applier runs against the REAL JobService and Postgres in the
 * backend's pipeline.integration.test.ts (resume, second-device undo); these
 * tests pin what only a call log shows: the request shapes the Confirm screen
 * sends, and that every undo fact is acked BEFORE the write it describes.
 */

import { describe, expect, test } from 'bun:test';
import type { MigrationJobView, MigrationPlan, PlanAckRequest, PlanResponse } from '@move/shared-types';
import { createMoveApi, errorCode, type MoveHttp } from '../lib/moveApi';
import { applyPlan, planHasPendingWork, undoPlan, type PlanSdk } from '../lib/planApplier';
import { completeLink, type LinkCompleter, mastodonMigrationUrl, normalizeSourceInput, outcomeFromParams, formatMentionHandle, startFailureKey } from '../lib/handles';
import { LINKED_ACCOUNT_CALLBACK_ERRORS, type LinkedAccount } from '@oxy.so/contracts';

const PLAN: MigrationPlan = {
  profile: { displayName: 'Ada', bio: 'Poet of numbers', avatarFileId: 'file-avatar', links: ['https://ada.example'] },
  graph: { followBatches: [['u1', 'u2'], ['u3'], ['u4', 'u5']], unresolved: 1, hidden: false },
  blocks: null,
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
  get response() {
    return { status: this.status, statusText: '', data: this.body };
  }
}

/** The backend, in memory: enough of jobs.routes.ts to drive the Confirm screen. */
function fakeBackend() {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  let job: (MigrationJobView & { plan: MigrationPlan }) | null = null;

  const view = (): MigrationJobView => {
    if (!job) throw new HttpError(404, { error: 'not_found' });
    const { plan: _plan, ...rest } = job;
    return rest;
  };

  const http: MoveHttp = {
    async get<T>(url: string): Promise<T> {
      requests.push({ method: 'GET', url });
      if (url === '/jobs') return { jobs: job ? [view()] : [] } as T;
      return { job: view() } as T;
    },
    async post<T>(url: string, body?: unknown): Promise<T> {
      requests.push({ method: 'POST', url, body });
      const input = body as { dryRun?: boolean; options?: MigrationJobView['options'] };
      if (url === '/jobs' && input.dryRun) {
        return {
          preview: {
            platform: 'mastodon',
            sourceActor: 'https://mastodon.example/users/ada',
            handle: '@ada@mastodon.example',
            profile: { displayName: 'Ada' },
            counts: { posts: 120, following: 5 },
            graphHidden: false,
          },
        } as T;
      }
      if (url === '/jobs') {
        if (job) throw new HttpError(409, { error: 'active_job_exists' });
        job = {
          id: 'job-1',
          platform: 'mastodon',
          linkedAccountId: 'la-1',
          sourceActor: 'https://mastodon.example/users/ada',
          sourceHandle: '@ada@mastodon.example',
          status: 'running',
          phases: { profile: { status: 'done' }, graph: { status: 'done' }, content: { status: 'running' } },
          counters: { read: 0, created: 0, existing: 0, failed: 0, skipped: 0, deferred: 0, mediaUploaded: 0, followsRead: 6, followsResolved: 5 },
          options: { content: true, graph: true, profile: true, includeBoosts: false, includeRepliesToOthers: false, ...input.options },
          error: null,
          pausedUntil: null,
          planAck: null,
          undo: null,
          createdAt: '2026-09-25T10:00:00.000Z',
          updatedAt: '2026-09-25T10:00:00.000Z',
          finishedAt: null,
          plan: PLAN,
        };
        return { job: view() } as T;
      }
      throw new HttpError(404, { error: 'not_found' });
    },
    async delete<T>(url: string): Promise<T> {
      requests.push({ method: 'DELETE', url });
      throw new HttpError(404, { error: 'not_found' });
    },
  };
  return { http, requests, current: () => job };
}

/** A call log shared by the fake API and SDK, so ORDER can be asserted. */
function fakeClient(plan: MigrationPlan) {
  const log: string[] = [];
  const state: PlanResponse = { plan, ack: null, undoFacts: null };
  const api = {
    plan: async () => structuredClone(state),
    ack: async (_id: string, ack: PlanAckRequest) => {
      log.push(`ack ${JSON.stringify(ack)}`);
      const facts = { ...(state.undoFacts ?? {}) };
      if (ack.profileBefore && !facts.profileBefore) facts.profileBefore = ack.profileBefore;
      if (ack.alreadyFollowing) facts.alreadyFollowing = { ...ack.alreadyFollowing, ...facts.alreadyFollowing };
      if (ack.alreadyBlocked) facts.alreadyBlocked = { ...ack.alreadyBlocked, ...facts.alreadyBlocked };
      state.undoFacts = facts;
      state.ack = {
        profileApplied: ack.profileApplied || state.ack?.profileApplied || false,
        followBatchesApplied: [...(state.ack?.followBatchesApplied ?? []), ...(ack.followBatchesApplied ?? [])],
        blockBatchesApplied: [...(state.ack?.blockBatchesApplied ?? []), ...(ack.blockBatchesApplied ?? [])],
      };
      return {};
    },
  };
  const sdk: PlanSdk = {
    users: {
      me: async () => ({ name: { displayName: 'Old' }, bio: 'old', avatar: null, links: [] }),
      updateMe: async (update) => void log.push(`updateProfile ${JSON.stringify(update)}`),
    },
    follows: {
      statuses: async (ids) => Object.fromEntries(ids.map((id) => [id, id === 'u2'])),
      followMany: async (ids) => void log.push(`follow ${ids.join(',')}`),
      unfollowMany: async (ids) => void log.push(`unfollow ${ids.join(',')}`),
    },
    privacy: {
      blocked: async () => [{ blockedId: { _id: 'b1' } }],
      block: async (id) => void log.push(`block ${id}`),
      unblock: async (id) => void log.push(`unblock ${id}`),
    },
  };
  return { api, sdk, log, state };
}

const FULL_PLAN: MigrationPlan = {
  ...PLAN,
  graph: { followBatches: [['u1', 'u2']], unresolved: 0, hidden: false },
  blocks: { blockBatches: [['b1', 'b2']], read: 2, unresolved: 0 },
};

describe('confirm → progress → undo', () => {
  test('Confirm sends a dry-run preview, then creates the job with the chosen options', async () => {
    const backend = fakeBackend();
    const api = createMoveApi(backend.http);

    const preview = await api.preview('mastodon', 'la-1');
    expect(preview.counts).toEqual({ posts: 120, following: 5 });
    expect(backend.requests[0]).toEqual({
      method: 'POST',
      url: '/jobs',
      body: { platform: 'mastodon', linkedAccountId: 'la-1', dryRun: true },
    });

    const job = await api.create('mastodon', 'la-1', { includeBoosts: true, includeRepliesToOthers: false });
    expect(job.id).toBe('job-1');
    expect(backend.requests[1].body).toEqual({
      platform: 'mastodon',
      linkedAccountId: 'la-1',
      options: { includeBoosts: true, includeRepliesToOthers: false },
    });

    // A second create is the backend's 409, surfaced as its machine code.
    const conflict = await api.create('mastodon', 'la-1', {}).catch((error: unknown) => error);
    expect(errorCode(conflict)).toBe('active_job_exists');
  });

  test('every undo fact is acked BEFORE the write it describes, and each write after it is acked', async () => {
    const { api, sdk, log, state } = fakeClient(FULL_PLAN);
    const progress = await applyPlan({ api, sdk }, 'job-1');

    expect(log).toEqual([
      'ack {"profileBefore":{"displayName":"Old","bio":"old","links":[]}}',
      'updateProfile {"name":{"displayName":"Ada"},"bio":"Poet of numbers","avatar":"file-avatar","links":["https://ada.example"]}',
      'ack {"profileApplied":true}',
      'ack {"alreadyFollowing":{"0":["u2"]}}',
      'follow u1,u2',
      'ack {"followBatchesApplied":[0]}',
      'ack {"alreadyBlocked":{"0":["b1"]}}',
      'block b2',
      'ack {"blockBatchesApplied":[0]}',
    ]);
    expect(progress).toMatchObject({ profile: 'applied', batchesApplied: 1, blockBatchesApplied: 1, blocksTotal: 2 });
    expect(planHasPendingWork(FULL_PLAN, state.ack)).toBe(false);

    // Undo from those facts: only what Move added goes. (The avatar had no
    // previous value, so it is not "restored" to nothing.)
    log.length = 0;
    const undone = await undoPlan({ sdk }, state);
    expect(log).toEqual([
      'unfollow u1',
      'unblock b2',
      'updateProfile {"name":{"displayName":"Old"},"bio":"old","links":[]}',
    ]);
    expect(undone).toEqual({ unfollowed: 1, unblocked: 1, kept: 2, profileRestored: true, profileKept: false });
  });

  test('a batch applied without a recorded fact is left alone rather than guessed', async () => {
    const { sdk, log } = fakeClient(FULL_PLAN);
    const undone = await undoPlan(
      { sdk },
      { plan: FULL_PLAN, ack: { profileApplied: true, followBatchesApplied: [0], blockBatchesApplied: [0] }, undoFacts: null },
    );
    expect(log).toEqual([]);
    expect(undone).toEqual({ unfollowed: 0, unblocked: 0, kept: 4, profileRestored: false, profileKept: true });
  });
});

describe('connect helpers', () => {
  test('Mastodon input accepts a handle, a bare server or a URL', () => {
    expect(normalizeSourceInput('mastodon', ' @ada@mastodon.social ')).toBe('@ada@mastodon.social');
    expect(normalizeSourceInput('mastodon', 'ada@mastodon.social')).toBe('ada@mastodon.social');
    expect(normalizeSourceInput('mastodon', 'mastodon.social')).toBe('mastodon.social');
    expect(normalizeSourceInput('mastodon', 'https://hachyderm.io/')).toBe('https://hachyderm.io/');
    expect(normalizeSourceInput('mastodon', '@ada')).toBeNull();
    expect(normalizeSourceInput('mastodon', '')).toBeNull();
  });

  test('Bluesky input takes a handle (with or without @) or a DID', () => {
    expect(normalizeSourceInput('bluesky', '@ada.bsky.social')).toBe('ada.bsky.social');
    expect(normalizeSourceInput('bluesky', 'did:plc:abc123')).toBe('did:plc:abc123');
    expect(normalizeSourceInput('bluesky', 'ada')).toBeNull();
  });

  test('the return route reads ?link_code= and every callback ?link_error= code', () => {
    expect(outcomeFromParams({ link_code: 'c-9' })).toEqual({ kind: 'code', code: 'c-9' });
    expect(outcomeFromParams({ link_code: '' })).toBeNull();
    // The callback no longer creates the link, so `?linked=` means nothing.
    expect(outcomeFromParams({ linked: 'la-9' } as never)).toBeNull();
    for (const code of LINKED_ACCOUNT_CALLBACK_ERRORS) {
      expect(outcomeFromParams({ link_error: code })).toEqual({ kind: 'error', code });
    }
    expect(outcomeFromParams({ link_error: 'made_up' })).toEqual({ kind: 'error', code: 'unknown' });
    // `error` is the SDK's OAuth parameter (and stripped on web): not ours.
    expect(outcomeFromParams({ error: 'access_denied' } as never)).toBeNull();
    expect(outcomeFromParams({})).toBeNull();
  });

  test('a code becomes the link only through linkedAccounts.complete, and each refusal is named', async () => {
    const codes: string[] = [];
    const oxy = (failWith?: number): LinkCompleter => ({
      linkedAccounts: {
        complete: async (code) => {
          codes.push(code);
          if (failWith) throw Object.assign(new Error(`HTTP ${failWith}`), { status: failWith });
          return { id: 'la-1' } as LinkedAccount;
        },
      },
    });

    expect(await completeLink(oxy(), 'c-1')).toEqual({ kind: 'linked', linkedAccountId: 'la-1' });
    expect(codes).toEqual(['c-1']);

    expect(await completeLink(oxy(409), 'c-2')).toEqual({ kind: 'error', code: 'already_linked' });
    // 403: another user started the flow (the code is now burned); 404: expired or used.
    expect(await completeLink(oxy(403), 'c-3')).toEqual({ kind: 'error', code: 'expired_or_foreign' });
    expect(await completeLink(oxy(404), 'c-4')).toEqual({ kind: 'error', code: 'expired_or_foreign' });
    expect(await completeLink(oxy(500), 'c-5')).toEqual({ kind: 'error', code: 'unknown' });
  });

  test("a refused start blames the handle only when Oxy says the handle did not resolve", () => {
    // What `oxyServices.linkedAccounts.start` throws for a 400: the SDK keeps the body's `details`.
    const refusal = (reason: string) => Object.assign(new Error('Bad request'), { status: 400, details: { reason } });
    expect(startFailureKey('bluesky', refusal('handle_unresolvable'))).toBe('connect.startFailed.handle_unresolvable');
    // Bluesky refusing Oxy's client metadata is not "we couldn't find that account".
    expect(startFailureKey('bluesky', refusal('provider_rejected'))).toBe('connect.startFailed.provider_rejected.bluesky');
    expect(startFailureKey('mastodon', refusal('provider_rejected'))).toBe('connect.startFailed.provider_rejected.mastodon');
    expect(startFailureKey('bluesky', refusal('provider_unavailable'))).toBe('connect.startFailed.provider_unavailable');
    expect(startFailureKey('mastodon', refusal('instance_unreachable'))).toBe('connect.startFailed.instance_unreachable');
    expect(startFailureKey('mastodon', refusal('instance_invalid'))).toBe('connect.startFailed.instance_invalid');
    // No reason, or one this build does not know: never a guess at the input.
    expect(startFailureKey('bluesky', new Error('Network error'))).toBe('connect.startFailed.unknown');
    expect(startFailureKey('bluesky', refusal('something_new'))).toBe('connect.startFailed.unknown');
  });

  test('the Mastodon move step targets the Mention handle and the source instance', () => {
    expect(formatMentionHandle('ada', 'mention.earth')).toBe('@ada@mention.earth');
    expect(mastodonMigrationUrl('https://mastodon.example/users/ada')).toBe('https://mastodon.example/settings/migration');
    expect(mastodonMigrationUrl('not a url')).toBeNull();
  });
});
