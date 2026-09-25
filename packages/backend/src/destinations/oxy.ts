/**
 * Oxy, from Move's backend: verify the linked account, resolve the graph to Oxy
 * user ids, notify on completion.
 *
 * It never WRITES the profile, follows or blocks: Oxy accepts those only from
 * the user's own session, so the Move CLIENT applies them from the plan.
 *
 * Contracts, and the privileged scope each needs on Move's Oxy application:
 * - `GET /linked-accounts/by-user/:userId` — `linked-accounts:read`
 *   (`@oxy.so/contracts` `serviceLinkedAccountListResponseSchema`).
 * - `POST /federation/identities/lookup` (batch ≤ 100, no remote discovery) and
 *   `POST /federation/identities/resolve` (one actor) — `federation:identities:resolve`.
 * - `POST /notifications` with `type: 'system'` — `notifications:write`.
 * - (`utils/oxyHelpers.ts`) `POST /assets/service/user-media` — `files:user-media:write`.
 */

import { z } from 'zod';
import { FOLLOW_BATCH_SIZE, type MigrationPlatform } from '@move/shared-types';
import { logger } from '../utils/logger';
import type { GraphAccount, SourceAccount } from '../sources/types';

/** An Oxy service call, as `OxyServices.makeServiceRequest` makes it (the SDK unwraps `{ data }`). */
export type ServiceRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>;

/** The fields Move reads of Oxy's service linked-account view. */
const linkedAccountsResponseSchema = z.object({
  linkedAccounts: z.array(
    z
      .object({
        id: z.string().min(1),
        network: z.string(),
        /** ActivityPub actor id, or the DID for atproto. */
        actorUri: z.string().min(1),
        handle: z.string().min(1),
      })
      .loose(),
  ),
});

/** Oxy proves ownership per protocol; each Move platform is one of them. */
const PLATFORM_NETWORK: Record<MigrationPlatform, 'activitypub' | 'atproto'> = {
  mastodon: 'activitypub',
  bluesky: 'atproto',
};

/** The linked account is not the caller's, not live, or not for this platform. */
export class ForeignLinkedAccountError extends Error {
  constructor(message = 'linked account does not belong to this user') {
    super(message);
    this.name = 'ForeignLinkedAccountError';
  }
}

const lookupResponseSchema = z.object({
  identities: z.array(z.object({ identifier: z.string(), userId: z.string().nullable() }).loose()),
});

const resolveResponseSchema = z.object({ user: z.object({ id: z.string().min(1) }).loose() }).loose();

const LOOKUP_BATCH = 100;
const RESOLVE_CONCURRENCY = 2;
/** Oxy's limits for `system` notifications. */
const SYSTEM_TITLE_MAX = 120;
const SYSTEM_MESSAGE_MAX = 500;

export class OxyGateway {
  constructor(private readonly request: ServiceRequest) {}

  /**
   * The linked account, verified to be the caller's AND for this platform.
   * Throws {@link ForeignLinkedAccountError} otherwise — a job never runs for
   * an account the user has not proven they own.
   */
  async verifyLinkedAccount(oxyUserId: string, linkedAccountId: string, platform: MigrationPlatform): Promise<SourceAccount> {
    const raw = await this.request('GET', `/linked-accounts/by-user/${encodeURIComponent(oxyUserId)}`);
    const account = linkedAccountsResponseSchema.parse(raw).linkedAccounts.find((entry) => entry.id === linkedAccountId);
    if (!account || account.network !== PLATFORM_NETWORK[platform]) throw new ForeignLinkedAccountError();
    const usable = platform === 'bluesky' ? account.actorUri.startsWith('did:') : /^https:\/\//i.test(account.actorUri);
    if (!usable) throw new ForeignLinkedAccountError('linked account has no usable actor');
    return { platform, actor: account.actorUri, handle: account.handle };
  }

  /**
   * Resolve accounts to Oxy user ids: a batched lookup of identities Oxy
   * already knows, then one `resolve` per miss (Oxy fetches and verifies the
   * source). Unresolvable accounts are simply absent from the map.
   */
  async resolveGraph(accounts: GraphAccount[]): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const actors = [...new Set(accounts.map((account) => account.actor))];
    for (let start = 0; start < actors.length; start += LOOKUP_BATCH) {
      const raw = await this.request('POST', '/federation/identities/lookup', { identifiers: actors.slice(start, start + LOOKUP_BATCH) });
      for (const identity of lookupResponseSchema.parse(raw).identities) {
        if (identity.userId) resolved.set(identity.identifier, identity.userId);
      }
    }

    const misses = actors.filter((actor) => !resolved.has(actor));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < misses.length) {
        const actorUri = misses[next++];
        try {
          const raw = await this.request('POST', '/federation/identities/resolve', {
            actorUri,
            protocol: actorUri.startsWith('did:') ? 'atproto' : 'activitypub',
          });
          const parsed = resolveResponseSchema.safeParse(raw);
          if (parsed.success) resolved.set(actorUri, parsed.data.user.id);
        } catch (error) {
          const status = (error as { status?: number } | null)?.status;
          // A 429 pauses the job; anything else only leaves this account unresolved.
          if (status === 429) throw error;
          logger.debug('[oxy] external identity unresolvable', { status });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, misses.length) }, worker));
    return resolved;
  }

  /**
   * Tell the user their migration finished (`system` notification: `title`,
   * `message` and a top-level `url`). `entityId` is the JOB id — Oxy dedupes on
   * (recipient, actor, type, entityId), so the user id there would 409 a user's
   * second migration — and `entityType: 'app'` names an id in Move's namespace.
   */
  async notifyMigrationDone(params: { oxyUserId: string; jobId: string; platform: MigrationPlatform; created: number }): Promise<void> {
    const platform = params.platform === 'mastodon' ? 'Mastodon' : 'Bluesky';
    await this.request('POST', '/notifications', {
      recipientId: params.oxyUserId,
      actorId: params.oxyUserId,
      type: 'system',
      entityId: params.jobId,
      entityType: 'app',
      title: `Your move from ${platform} is complete`.slice(0, SYSTEM_TITLE_MAX),
      message: `Oxy Move brought ${params.created} posts over from ${platform}.`.slice(0, SYSTEM_MESSAGE_MAX),
      url: `https://move.oxy.so/jobs/${encodeURIComponent(params.jobId)}`,
      data: { app: 'move', jobId: params.jobId, platform: params.platform },
    });
  }
}

/** Split user ids into client-sized batches, preserving order and dropping duplicates. */
export function toFollowBatches(userIds: Iterable<string>, size = FOLLOW_BATCH_SIZE): string[][] {
  const unique = [...new Set(userIds)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += size) batches.push(unique.slice(start, start + size));
  return batches;
}
