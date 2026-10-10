import { describe, expect, test } from 'bun:test';
import { DEFAULT_JOB_OPTIONS, type JobOptions } from '@move/shared-types';
import { MastodonSource, type CollectionCursor } from '../sources/mastodon';
import { SourceAuthRequiredError } from '../sources/http';
import { isSkipped, type SkippedItem, type SourceItem } from '../sources/types';
import {
  GARGRON,
  createFixtureFetcher,
  fixture,
  mastodonRoutes,
  type Route,
} from './helpers/fixtureFetcher';

const STATUS = (id: string) => `${GARGRON}/statuses/${id}`;

function source(routes = mastodonRoutes(), signedRoutes?: Record<string, Route>) {
  const fetcher = createFixtureFetcher(routes, signedRoutes);
  return {
    fetcher,
    source: new MastodonSource(
      { platform: 'mastodon', actor: GARGRON, handle: 'Gargron@mastodon.social' },
      fetcher,
    ),
  };
}

async function readAll(
  src: MastodonSource,
  options: JobOptions = DEFAULT_JOB_OPTIONS,
  cursor: CollectionCursor | null = null,
) {
  const out: Array<{ value: SourceItem | SkippedItem; cursor: CollectionCursor }> = [];
  for await (const entry of src.items({ cursor, options })) out.push(entry);
  return out;
}

function byId(
  entries: Array<{ value: SourceItem | SkippedItem }>,
  id: string,
): SourceItem | SkippedItem {
  const found = entries.find((entry) => entry.value.sourceId === id);
  if (!found) throw new Error(`no item ${id}`);
  return found.value;
}

describe('Mastodon source (recorded mastodon.social responses)', () => {
  test('profile falls back to the public REST lookup when the actor needs a signature', async () => {
    const { source: src, fetcher } = source();
    const profile = await src.profile();
    expect(fetcher.calls).toContain('https://mastodon.social/api/v1/accounts/lookup?acct=Gargron');
    expect(profile.displayName).toBe('Eugen Rochko');
    expect(profile.bio).toContain('@Mastodon');
    expect(profile.bio).not.toContain('<');
    expect(profile.avatarUrl).toStartWith('https://files.mastodon.social/accounts/avatars/');
    expect(profile.followingCount).toBe(742);
    expect(profile.links).toContain('https://github.com/Gargron');
    expect(profile.graphHidden).toBe(false);
  });

  test('negative control: a REST lookup for ANOTHER account is refused', async () => {
    const routes = mastodonRoutes();
    const lookup = routes['https://mastodon.social/api/v1/accounts/lookup?acct=Gargron'] as Record<
      string,
      unknown
    >;
    routes['https://mastodon.social/api/v1/accounts/lookup?acct=Gargron'] = {
      ...lookup,
      uri: 'https://mastodon.social/users/someoneelse',
    };
    await expect(source(routes).source.profile()).rejects.toThrow('different account');
  });

  test('without a signer, an instance that refuses the outbox unsigned fails as authorized-fetch, not as empty', async () => {
    const routes = mastodonRoutes();
    routes[`${GARGRON}/outbox`] = { status: 401, body: { error: 'Request not signed' } };
    await expect(readAll(source(routes).source)).rejects.toBeInstanceOf(SourceAuthRequiredError);
  });

  test('maps the recorded outbox: boosts off, replies to others skipped, self-thread and self-quote kept', async () => {
    const entries = await readAll(source().source);
    const skipped = entries
      .filter((entry) => isSkipped(entry.value))
      .map((entry) => (entry.value as SkippedItem).reason);
    expect(skipped).toContain('boost-disabled');
    expect(skipped).toContain('reply-to-other');

    const quote = byId(entries, STATUS('117330917869779654')) as SourceItem;
    expect(quote.quoteSourceId).toBe(STATUS('117327932994028225'));
    expect(quote.links).toBeUndefined();
    expect(quote.text).toContain('Reposting for the morning crew');

    const selfReply = byId(entries, STATUS('117294179974600212')) as SourceItem;
    expect(selfReply.replyToSourceId).toBe(STATUS('117293597728332882'));
    expect(selfReply.text).toBe('I got to talk to Gleeb!');

    const reply = byId(entries, STATUS('117328495945801440'));
    expect(isSkipped(reply)).toBe(true);
  });

  test('content warning, sensitivity, mentions and media survive the mapping', async () => {
    const entries = await readAll(source().source);
    const cw = byId(entries, `${STATUS('117275964345327101')}9`) as SourceItem;
    expect(cw.contentWarning).toBe('spoilers: the ending of the film');
    expect(cw.sensitive).toBe(true);

    const mention = byId(entries, STATUS('117275979075957026')) as SourceItem;
    expect(mention.text).toStartWith('@neil');
    expect(mention.text).not.toContain('https://mastodon.neilzone.co.uk/@neil');

    const withMedia = byId(entries, STATUS('117293597728332882')) as SourceItem;
    expect(withMedia.media.length).toBe(1);
    expect(withMedia.media[0].mimeType).toBe('image/jpeg');
    expect(withMedia.media[0].url).toStartWith('https://files.mastodon.social/media_attachments/');
    expect(withMedia.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(withMedia.visibility).toBe('public');

    // A link-preview `Link` attachment is not media.
    const linkOnly = byId(entries, STATUS('117327932994028225')) as SourceItem;
    expect(linkOnly.media).toEqual([]);
  });

  test('boosts are imported as a link to the original only when asked', async () => {
    const entries = await readAll(source().source, { ...DEFAULT_JOB_OPTIONS, includeBoosts: true });
    const boost = entries
      .map((entry) => entry.value)
      .find((value) => value.kind === 'boost') as SourceItem;
    expect(boost).toBeDefined();
    expect(boost.links?.length).toBe(1);
    expect(boost.text).toBe(boost.links?.[0] ?? '');
  });

  test('resuming from a cursor continues exactly after the last yielded item, across pages', async () => {
    const all = await readAll(source().source);
    const cut = 3;
    const resumed = await readAll(source().source, DEFAULT_JOB_OPTIONS, all[cut - 1].cursor);
    expect(resumed.map((entry) => entry.value.sourceId)).toEqual(
      all.slice(cut).map((entry) => entry.value.sourceId),
    );
    // The last page's cursor points past its end: nothing is re-yielded.
    const tail = await readAll(source().source, DEFAULT_JOB_OPTIONS, all[all.length - 1].cursor);
    expect(tail).toEqual([]);
  });

  test('negative control: a cross-origin `next` page is never followed', async () => {
    const routes = mastodonRoutes();
    const page1 = routes[`${GARGRON}/outbox?page=true`] as Record<string, unknown>;
    routes[`${GARGRON}/outbox?page=true`] = {
      ...page1,
      next: 'https://evil.example/users/Gargron/outbox?page=2',
    };
    const { source: src, fetcher } = source(routes);
    await readAll(src);
    expect(fetcher.calls.some((url) => url.startsWith('https://evil.example'))).toBe(false);
  });

  test('graph reads the following collection', async () => {
    const accounts: string[] = [];
    for await (const { value } of source().source.graph({
      cursor: null,
      options: DEFAULT_JOB_OPTIONS,
    }))
      accounts.push(value.actor);
    expect(accounts.length).toBe(5);
    expect(accounts.every((uri) => uri.startsWith('https://'))).toBe(true);
  });
});

/**
 * An instance in authorized-fetch ("secure") mode: every UNSIGNED read is
 * refused, and the same reads signed by Oxy's instance actor are served.
 */
function secureModeRoutes(): { unsigned: Record<string, Route>; signed: Record<string, Route> } {
  const signed = mastodonRoutes();
  // `actor.json` is built from the recorded REST lookup: the signed actor
  // could not be recorded before Move had a signer.
  signed[GARGRON] = fixture('mastodon/actor.json');
  const unsigned: Record<string, Route> = {};
  for (const url of Object.keys(signed))
    unsigned[url] = { status: 401, body: { error: 'Request not signed' } };
  return { unsigned, signed };
}

describe('Mastodon source on an authorized-fetch instance (signed by Oxy)', () => {
  test('reads the outbox and the graph once Oxy signs, where unsigned it got nothing', async () => {
    const { unsigned, signed } = secureModeRoutes();
    const { source: src, fetcher } = source(unsigned, signed);
    const entries = await readAll(src);
    expect(entries.length).toBeGreaterThan(3);
    const graph: string[] = [];
    for await (const entry of src.graph({ cursor: null, options: DEFAULT_JOB_OPTIONS }))
      graph.push(entry.value.actor);
    expect(graph.length).toBeGreaterThan(0);
    expect(fetcher.signedCalls).toContain(`${GARGRON}/outbox?page=true`);
    expect(fetcher.signedCalls).toContain(`${GARGRON}/following?page=1`);
  });

  test('once a collection needed a signature, the host is signed straight away', async () => {
    const { unsigned, signed } = secureModeRoutes();
    const { source: src, fetcher } = source(unsigned, signed);
    await readAll(src);
    // The actor and the outbox collection were each tried unsigned first; the
    // pages after that went signed with no refused round trip.
    const unsignedOnly = fetcher.calls.filter(
      (url, index) => fetcher.calls.indexOf(url) === index && !fetcher.signedCalls.includes(url),
    );
    expect(unsignedOnly).toEqual([]);
    const tries = (url: string) => fetcher.calls.filter((call) => call === url).length;
    expect(tries(`${GARGRON}/outbox`)).toBe(2);
    expect(tries(`${GARGRON}/outbox?page=true`)).toBe(1);
    expect(tries(`${GARGRON}/outbox?max_id=117293597728332883&page=true`)).toBe(1);
  });

  test('a refused unsigned ACTOR alone (mastodon.social) does not switch the collections to signing', async () => {
    const routes = mastodonRoutes();
    const { source: src, fetcher } = source(routes, { [GARGRON]: fixture('mastodon/actor.json') });
    await readAll(src);
    expect(fetcher.signedCalls).toEqual([GARGRON]);
    expect(fetcher.calls).not.toContain(
      'https://mastodon.social/api/v1/accounts/lookup?acct=Gargron',
    );
  });

  test('a server that refuses the signed read too fails as authorized-fetch', async () => {
    const { unsigned } = secureModeRoutes();
    const { source: src } = source(unsigned, { ...unsigned });
    await expect(readAll(src)).rejects.toBeInstanceOf(SourceAuthRequiredError);
  });
});
