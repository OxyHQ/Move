/**
 * Replays recorded responses by URL, so source tests run the REAL mapping and
 * paging code against real payload shapes without a network.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonFetcher, JsonResponse } from '../../sources/http';

const FIXTURES = join(__dirname, '..', 'fixtures');

export function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, path), 'utf8')) as Record<string, unknown>;
}

export type Route = { status: number; body?: unknown; headers?: Record<string, string> } | Record<string, unknown>;

export interface FixtureFetcher extends JsonFetcher {
  calls: string[];
}

/**
 * `routes` maps an exact URL (or a URL prefix ending in `*`) to a fixture body
 * or an explicit `{ status }` answer. An unmapped URL is a TEST failure, not a
 * 404: a source reaching for something the test did not expect is a finding.
 */
export function createFixtureFetcher(routes: Record<string, Route>): FixtureFetcher {
  const calls: string[] = [];
  const fetcher = (async (url: string): Promise<JsonResponse> => {
    calls.push(url);
    const key = routes[url] !== undefined
      ? url
      : Object.keys(routes).find((candidate) => candidate.endsWith('*') && url.startsWith(candidate.slice(0, -1)));
    if (!key) throw new Error(`unexpected fetch in test: ${url}`);
    const route = routes[key];
    if (typeof route === 'object' && route !== null && 'status' in route && typeof route.status === 'number') {
      return { status: route.status, headers: (route.headers as Record<string, string>) ?? {}, body: route.body };
    }
    return { status: 200, headers: {}, body: JSON.parse(JSON.stringify(route)) };
  }) as unknown as FixtureFetcher;
  fetcher.calls = calls;
  return fetcher;
}

export const GARGRON = 'https://mastodon.social/users/Gargron';
export const JAY_DID = 'did:plc:oky5czdrnfjpqslsw2a5iclo';
/** The PDS the Bluesky tests hand the source (the fixtures' blob and block URLs use it). */
export const BSKY_PDS = 'https://pds.example.bsky.network';

/** Every URL the Mastodon fixtures answer, as the recording found them. */
export function mastodonRoutes(): Record<string, Route> {
  return {
    // MEASURED: mastodon.social refuses the unsigned actor GET.
    [GARGRON]: { status: 401, body: { error: 'Request not signed' } },
    'https://mastodon.social/api/v1/accounts/lookup?acct=Gargron': fixture('mastodon/account-lookup.json'),
    [`${GARGRON}/outbox`]: fixture('mastodon/outbox.json'),
    [`${GARGRON}/outbox?page=true`]: fixture('mastodon/outbox-page1.json'),
    [`${GARGRON}/outbox?max_id=117293597728332883&page=true`]: fixture('mastodon/outbox-page2.json'),
    [`${GARGRON}/following`]: fixture('mastodon/following.json'),
    [`${GARGRON}/following?page=1`]: fixture('mastodon/following-page1.json'),
    [`${GARGRON}/followers`]: { status: 200, body: { type: 'OrderedCollection', totalItems: 382784, first: `${GARGRON}/followers?page=1` } },
  };
}

export function blueskyRoutes(): Record<string, Route> {
  const appView = 'https://public.api.bsky.app/xrpc';
  return {
    [`${appView}/app.bsky.actor.getProfile?actor=${encodeURIComponent(JAY_DID)}`]: fixture('bluesky/profile.json'),
    [`${appView}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(JAY_DID)}&limit=100&filter=posts_and_author_threads`]: fixture('bluesky/author-feed-page1.json'),
    [`${appView}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(JAY_DID)}&limit=100&cursor=2026-06-20T00%3A00%3A00.000Z&filter=posts_and_author_threads`]: fixture('bluesky/author-feed-page2.json'),
    [`${appView}/app.bsky.graph.getFollows?actor=${encodeURIComponent(JAY_DID)}&limit=100`]: fixture('bluesky/follows.json'),
    // Block records from the author's PDS (recorded 2026-09-25 from Jay's real
    // repo, trimmed to 3 + 2 records; page 2's cursor removed to end the list).
    [`${BSKY_PDS}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(JAY_DID)}&collection=app.bsky.graph.block&limit=100`]: fixture('bluesky/blocks-page1.json'),
    [`${BSKY_PDS}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(JAY_DID)}&collection=app.bsky.graph.block&limit=100&cursor=3miadgho7gx26`]: fixture('bluesky/blocks-page2.json'),
  };
}
