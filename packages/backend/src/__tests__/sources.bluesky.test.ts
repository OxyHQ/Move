import { describe, expect, test } from 'bun:test';
import { DEFAULT_JOB_OPTIONS, type JobOptions } from '@move/shared-types';
import { BlueskySource, type PageCursor } from '../sources/bluesky';
import { DEFAULT_BACKOFF, SourceRateLimitedError, withBackoff } from '../sources/http';
import { isSkipped, type GraphAccount, type SkippedItem, type SourceItem } from '../sources/types';
import { BSKY_PDS as PDS, JAY_DID, blueskyRoutes, createFixtureFetcher, fixture } from './helpers/fixtureFetcher';

/** The recorded routes minus the block pages, so a test can answer those itself. */
function followsOnlyRoutes() {
  return Object.fromEntries(Object.entries(blueskyRoutes()).filter(([url]) => !url.includes('listRecords')));
}

function fixtureSubjects(file: string): string[] {
  return (fixture(`bluesky/${file}`).records as Array<{ value: { subject: string } }>).map((record) => record.value.subject);
}

const POST = (rkey: string) => `at://${JAY_DID}/app.bsky.feed.post/${rkey}`;

function source(pdsEndpoint: string | null = PDS) {
  const fetcher = createFixtureFetcher(blueskyRoutes());
  return {
    fetcher,
    source: new BlueskySource({ platform: 'bluesky', actor: JAY_DID, handle: 'jay.bsky.team' }, fetcher, { pdsEndpoint: pdsEndpoint ?? undefined }),
  };
}

async function readAll(src: BlueskySource, options: JobOptions = DEFAULT_JOB_OPTIONS, cursor: PageCursor | null = null) {
  const out: Array<{ value: SourceItem | SkippedItem; cursor: PageCursor }> = [];
  for await (const entry of src.items({ cursor, options })) out.push(entry);
  return out;
}

function get(entries: Array<{ value: SourceItem | SkippedItem }>, id: string): SourceItem | SkippedItem {
  const found = entries.find((entry) => entry.value.sourceId === id);
  if (!found) throw new Error(`no item ${id}`);
  return found.value;
}

describe('Bluesky source (recorded public AppView responses)', () => {
  test('profile maps getProfile', async () => {
    const profile = await source().source.profile();
    expect(profile.actor).toBe(JAY_DID);
    expect(profile.handle).toBe('jay.bsky.team');
    expect(profile.displayName).toBeTruthy();
    expect(typeof profile.followingCount).toBe('number');
  });

  test('images and video are the ORIGINAL blobs from the PDS, with alt text and MIME', async () => {
    const entries = await readAll(source().source);
    const images = get(entries, POST('3mvvdpby3x22t')) as SourceItem;
    expect(images.media).toEqual([
      {
        url: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(JAY_DID)}&cid=bafkreic4ht5ww2pplaulfcyqxqwm6ym5x74zxjpr6dv3oscce7afbifya4`,
        mimeType: 'image/jpeg',
        alt: 'two puppies',
      },
    ]);
    const video = get(entries, POST('3mvorbgjaks24')) as SourceItem;
    expect(video.media[0].mimeType).toBe('video/mp4');
    expect(video.media[0].url).toContain('com.atproto.sync.getBlob');
  });

  test('without a PDS, images fall back to the CDN and video (HLS only) is dropped', async () => {
    const entries = await readAll(source(null).source);
    const images = get(entries, POST('3mvvdpby3x22t')) as SourceItem;
    expect(images.media[0].url).toStartWith('https://cdn.bsky.app/');
    const video = get(entries, POST('3mvorbgjaks24')) as SourceItem;
    expect(video.media).toEqual([]);
  });

  test('reposts off, replies to others skipped — including a self-reply under someone else\'s root', async () => {
    const entries = await readAll(source().source);
    const reasons = entries.filter((entry) => isSkipped(entry.value)).map((entry) => [entry.value.sourceId, (entry.value as SkippedItem).reason]);
    expect(reasons.some(([, reason]) => reason === 'boost-disabled')).toBe(true);
    expect(isSkipped(get(entries, POST('3mvqo2jcqlk25')))).toBe(true);
    // Parent is Jay's own post, but the thread ROOT is someone else's: a conversation, not a self-thread.
    expect(isSkipped(get(entries, POST('3mvh5dnvywc2b')))).toBe(true);
  });

  test('a self-thread keeps its parent; the parent arrives later (newest first)', async () => {
    const entries = await readAll(source().source);
    const child = get(entries, POST('3mv2ijovls22r')) as SourceItem;
    expect(child.replyToSourceId).toBe(POST('3mv2iclsgxk2r'));
    const ids = entries.map((entry) => entry.value.sourceId);
    expect(ids.indexOf(POST('3mv2iclsgxk2r'))).toBeGreaterThan(ids.indexOf(POST('3mv2ijovls22r')));
  });

  test('a quote of someone else becomes a link; a self-quote keeps its source id', async () => {
    const entries = await readAll(source().source);
    const other = get(entries, POST('3mvhgk4t7gc2y')) as SourceItem;
    expect(other.quoteSourceId).toBeUndefined();
    expect(other.links?.[0]).toStartWith('https://bsky.app/profile/moultano.bsky.social/post/');
    const self = get(entries, POST('3mvhgk4t7gc2z')) as SourceItem;
    expect(self.quoteSourceId).toBe(POST('3mv2iclsgxk2r'));
  });

  test('an adult self-label becomes the content warning', async () => {
    const entries = await readAll(source().source);
    const labelled = get(entries, POST('3mvjnvtfw4s2d')) as SourceItem;
    expect(labelled.contentWarning).toBe('Nudity');
    expect(labelled.sensitive).toBe(true);
    const plain = get(entries, POST('3mvvdpby3x22t')) as SourceItem;
    expect(plain.contentWarning).toBeUndefined();
  });

  test('reposts become a link to the original when asked', async () => {
    const entries = await readAll(source().source, { ...DEFAULT_JOB_OPTIONS, includeBoosts: true });
    const boost = entries.map((entry) => entry.value).find((value) => value.kind === 'boost') as SourceItem;
    expect(boost.links?.[0]).toStartWith('https://bsky.app/profile/');
  });

  test('resuming from a cursor continues exactly after the last yielded item, across pages', async () => {
    const all = await readAll(source().source);
    for (const cut of [1, 4, all.length - 1]) {
      const resumed = await readAll(source().source, DEFAULT_JOB_OPTIONS, all[cut - 1].cursor);
      expect(resumed.map((entry) => entry.value.sourceId)).toEqual(all.slice(cut).map((entry) => entry.value.sourceId));
    }
  });

  test('graph reads getFollows, then the public block records from the PDS', async () => {
    const graph: GraphAccount[] = [];
    for await (const { value } of source().source.graph({ cursor: null, options: DEFAULT_JOB_OPTIONS })) graph.push(value);
    const follows = graph.filter((account) => account.relation !== 'block');
    const blocks = graph.filter((account) => account.relation === 'block');
    expect(follows.length).toBe(3);
    expect(follows.every((account) => account.actor.startsWith('did:'))).toBe(true);
    // Follows come first, then every block across both record pages.
    expect(graph.slice(0, 3)).toEqual(follows);
    expect(blocks.map((account) => account.actor)).toEqual([
      'did:plc:lhnfzt5en3xcgjyucabidumj',
      'did:plc:slca7d33txjmc6hohu3aenmw',
      'did:plc:fvuvnr3tl55jdz5hsaa7iecs',
      ...fixtureSubjects('blocks-page2.json'),
    ]);
  });

  test('graph resumes inside the blocks without re-reading the follows', async () => {
    const all: Array<{ value: GraphAccount; cursor: PageCursor }> = [];
    for await (const entry of source().source.graph({ cursor: null, options: DEFAULT_JOB_OPTIONS })) all.push(entry);
    for (const cut of [2, 3, 4, all.length - 1]) {
      const { source: src, fetcher } = source();
      const resumed: string[] = [];
      for await (const { value } of src.graph({ cursor: all[cut - 1].cursor, options: DEFAULT_JOB_OPTIONS })) resumed.push(value.actor);
      expect(resumed).toEqual(all.slice(cut).map((entry) => entry.value.actor));
      // A cursor INSIDE the blocks (after the 3 follows) never goes back to them.
      if (cut > 3) expect(fetcher.calls.some((url) => url.includes('getFollows'))).toBe(false);
    }
  });

  test('without a PDS there is nowhere public to read blocks: follows only', async () => {
    const graph: GraphAccount[] = [];
    for await (const { value } of source(null).source.graph({ cursor: null, options: DEFAULT_JOB_OPTIONS })) graph.push(value);
    expect(graph).toHaveLength(3);
    expect(graph.some((account) => account.relation === 'block')).toBe(false);
  });

  test('a refused or missing block read loses only the blocks; a 429 still pauses', async () => {
    // Through the production backoff layer, which is what turns a 404 into
    // SourceUnavailableError and a 429 into a pause.
    const policy = { ...DEFAULT_BACKOFF, minIntervalMs: 0, maxAttempts: 1 };
    const blocksAnswer = (answer: { status: number; body: unknown }) =>
      new BlueskySource(
        { platform: 'bluesky', actor: JAY_DID, handle: 'jay.bsky.team' },
        withBackoff(createFixtureFetcher({ ...followsOnlyRoutes(), [`${PDS}/xrpc/com.atproto.repo.listRecords*`]: answer }), policy, async () => undefined),
        { pdsEndpoint: PDS },
      );
    for (const answer of [{ status: 400, body: { error: 'RepoNotFound' } }, { status: 404, body: {} }]) {
      const graph: GraphAccount[] = [];
      for await (const { value } of blocksAnswer(answer).graph({ cursor: null, options: DEFAULT_JOB_OPTIONS })) graph.push(value);
      expect(graph).toHaveLength(3);
    }
    await expect((async () => {
      for await (const _ of blocksAnswer({ status: 429, body: {} }).graph({ cursor: null, options: DEFAULT_JOB_OPTIONS })) void _;
    })()).rejects.toBeInstanceOf(SourceRateLimitedError);
  });
});
