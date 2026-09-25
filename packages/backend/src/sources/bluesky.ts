/**
 * Bluesky (atproto) as a Move source.
 *
 * Everything is PUBLIC XRPC on the Bluesky AppView — `app.bsky.actor.getProfile`,
 * `app.bsky.feed.getAuthorFeed`, `app.bsky.graph.getFollows` — so no token is
 * held (Oxy's OAuth proved ownership and discarded it). Blocks are public too,
 * but only as repo records: `com.atproto.repo.listRecords` on the author's PDS
 * (`app.bsky.graph.block`), read after the follows.
 *
 * Media are read from the RECORD's blob refs and fetched as the ORIGINAL blob
 * from the author's PDS (`com.atproto.sync.getBlob`), never from the AppView
 * view: the view gives a recompressed JPEG for an image and an HLS playlist for
 * a video, and a playlist is not a file that can be copied into Oxy. When the
 * PDS is unknown (DID document unreachable), images fall back to the view's
 * `fullsize` CDN URL and videos are skipped.
 *
 * Both cursors are `{ page, index }`: `page` is the AppView cursor that
 * produced the current page (undefined for the first) and `index` the position
 * inside it, so a restart re-requests that page and continues without
 * re-yielding.
 */

import { normalizeInlineText, normalizeMultilineText } from '@oxy.so/core';
import type { MigrationPlatform } from '@move/shared-types';
import { PUBLIC_APPVIEW, buildXrpcUrl } from '../connectors/atproto/xrpcClient';
import {
  POST_COLLECTION,
  adultLabels,
  applyFacetReplacements,
  buildFacetReplacements,
  bskyPostUrl,
  extractQuoted,
  normalizeLangs,
  parseAtUri,
  parseCreatedAt,
  type AtprotoAuthorFeed,
  type AtprotoBlobRef,
  type AtprotoFeedItem,
  type AtprotoProfileView,
  type AtprotoRecordEmbed,
  type AtprotoEmbedView,
} from '../connectors/atproto/postView';
import { SourceHttpError, SourceUnavailableError, type JsonFetcher, type JsonResponse } from './http';
import type {
  GraphAccount,
  Positioned,
  SkippedItem,
  Source,
  SourceAccount,
  SourceItem,
  SourceMedia,
  SourceProfile,
  SourceReadContext,
} from './types';

export interface PageCursor {
  page?: string;
  index: number;
  /** graph() only: `blocks` once the follows are read. Absent = follows. */
  stage?: 'blocks';
}

const BLOCK_COLLECTION = 'app.bsky.graph.block';

const PAGE_LIMIT = 100;
const MAX_PAGES = 10_000;

/** Human wording for Bluesky's adult self-labels, used as the content warning. */
const LABEL_WARNINGS: Record<string, string> = {
  porn: 'Adult content',
  sexual: 'Sexually suggestive',
  nudity: 'Nudity',
  'graphic-media': 'Graphic media',
};

export class BlueskySource implements Source<PageCursor, PageCursor> {
  readonly platform: MigrationPlatform = 'bluesky';

  constructor(
    private readonly account: SourceAccount,
    private readonly fetchJson: JsonFetcher,
    /** The author's PDS (from the DID document): original blobs and block records. */
    private readonly options: { pdsEndpoint?: string } = {},
  ) {}

  private get did(): string {
    return this.account.actor;
  }

  private async xrpc<T>(nsid: string, params: Record<string, string | number | undefined>): Promise<T> {
    const response = await this.fetchJson(buildXrpcUrl(PUBLIC_APPVIEW, nsid, params), { accept: 'application/json' });
    if (response.status < 200 || response.status >= 300) {
      throw new SourceHttpError(`${nsid} answered ${response.status}`, response.status);
    }
    return response.body as T;
  }

  async profile(): Promise<SourceProfile> {
    const view = await this.xrpc<AtprotoProfileView>('app.bsky.actor.getProfile', { actor: this.did });
    if (view.did !== this.did) throw new SourceHttpError('profile DID does not match the linked account', 200);
    // An unverified handle reads `handle.invalid`; the linked handle is better.
    const handle = view.handle && view.handle !== 'handle.invalid' ? view.handle : this.account.handle;
    return {
      actor: this.did,
      handle,
      displayName: view.displayName ? normalizeInlineText(view.displayName) || undefined : undefined,
      bio: view.description ? normalizeMultilineText(view.description) || undefined : undefined,
      avatarUrl: view.avatar || undefined,
      postsCount: view.postsCount,
      followingCount: view.followsCount,
      followersCount: view.followersCount,
    };
  }

  async dateRange(): Promise<{ newestAt?: string; oldestAt?: string }> {
    const feed = await this.xrpc<AtprotoAuthorFeed>('app.bsky.feed.getAuthorFeed', {
      actor: this.did,
      limit: 5,
      filter: 'posts_and_author_threads',
    });
    const first = (feed.feed ?? []).find((item) => !item.reason);
    const newest = parseCreatedAt(first?.post?.record?.createdAt);
    return { newestAt: newest?.toISOString() };
  }

  async *items(
    context: SourceReadContext<PageCursor>,
  ): AsyncIterable<Positioned<SourceItem | SkippedItem, PageCursor>> {
    const filter = context.options.includeRepliesToOthers ? 'posts_with_replies' : 'posts_and_author_threads';
    let page = context.cursor?.page;
    let offset = context.cursor?.index ?? 0;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const response = await this.xrpc<AtprotoAuthorFeed>('app.bsky.feed.getAuthorFeed', {
        actor: this.did,
        limit: PAGE_LIMIT,
        cursor: page,
        filter,
      });
      const feed = Array.isArray(response.feed) ? response.feed : [];
      for (let index = Math.min(offset, feed.length); index < feed.length; index++) {
        const mapped = this.mapFeedItem(feed[index], context);
        if (mapped) yield { value: mapped, cursor: { page, index: index + 1 } };
      }
      offset = 0;
      if (!response.cursor || feed.length === 0 || response.cursor === page) return;
      page = response.cursor;
    }
  }

  async *graph(context: SourceReadContext<PageCursor>): AsyncIterable<Positioned<GraphAccount, PageCursor>> {
    if (context.cursor?.stage !== 'blocks') yield* this.follows(context.cursor);
    yield* this.blocks(context.cursor?.stage === 'blocks' ? context.cursor : null);
  }

  private async *follows(cursor: PageCursor | null): AsyncIterable<Positioned<GraphAccount, PageCursor>> {
    let page = cursor?.page;
    let offset = cursor?.index ?? 0;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const response = await this.xrpc<{ follows?: Array<{ did?: string; handle?: string }>; cursor?: string }>(
        'app.bsky.graph.getFollows',
        { actor: this.did, limit: PAGE_LIMIT, cursor: page },
      );
      const follows = Array.isArray(response.follows) ? response.follows : [];
      for (let index = Math.min(offset, follows.length); index < follows.length; index++) {
        const follow = follows[index];
        if (typeof follow?.did !== 'string' || !follow.did.startsWith('did:')) continue;
        yield { value: { actor: follow.did, handle: follow.handle }, cursor: { page, index: index + 1 } };
      }
      offset = 0;
      if (!response.cursor || follows.length === 0 || response.cursor === page) return;
      page = response.cursor;
    }
  }

  /**
   * The author's block records, from their PDS. Without a PDS (DID document
   * unreachable) there is nowhere public to read them, so blocks are skipped;
   * a PDS that refuses the read (repo moved, 404) loses only the blocks. A 429
   * or 5xx is the backoff layer's: it pauses or retries like every other read.
   */
  private async *blocks(cursor: PageCursor | null): AsyncIterable<Positioned<GraphAccount, PageCursor>> {
    let pdsHost: string | undefined;
    try {
      pdsHost = this.options.pdsEndpoint ? new URL(this.options.pdsEndpoint).host : undefined;
    } catch {
      pdsHost = undefined;
    }
    if (!pdsHost) return;
    let page = cursor?.page;
    let offset = cursor?.index ?? 0;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const url = buildXrpcUrl(pdsHost, 'com.atproto.repo.listRecords', {
        repo: this.did,
        collection: BLOCK_COLLECTION,
        limit: PAGE_LIMIT,
        cursor: page,
      });
      let response: JsonResponse;
      try {
        response = await this.fetchJson(url, { accept: 'application/json' });
      } catch (error) {
        if (error instanceof SourceUnavailableError) return;
        throw error;
      }
      if (response.status < 200 || response.status >= 300) return;
      const body = response.body as { records?: Array<{ value?: { $type?: string; subject?: unknown } }>; cursor?: string };
      const records = Array.isArray(body.records) ? body.records : [];
      for (let index = Math.min(offset, records.length); index < records.length; index++) {
        const subject = records[index]?.value?.subject;
        if (records[index]?.value?.$type !== BLOCK_COLLECTION || typeof subject !== 'string' || !subject.startsWith('did:')) continue;
        yield { value: { actor: subject, relation: 'block' }, cursor: { stage: 'blocks', page, index: index + 1 } };
      }
      offset = 0;
      if (!body.cursor || records.length === 0 || body.cursor === page) return;
      page = body.cursor;
    }
  }

  /** Original blob URL on the author's PDS, when known. */
  private blobUrl(blob: AtprotoBlobRef | undefined): string | undefined {
    const cid = blob?.ref?.$link ?? blob?.cid;
    if (!cid || !this.options.pdsEndpoint) return undefined;
    const base = this.options.pdsEndpoint.replace(/\/+$/, '');
    return `${base}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(this.did)}&cid=${encodeURIComponent(cid)}`;
  }

  private media(recordEmbed: AtprotoRecordEmbed | undefined, viewEmbed: AtprotoEmbedView | undefined): SourceMedia[] {
    const out: SourceMedia[] = [];
    const record = recordEmbed?.$type === 'app.bsky.embed.recordWithMedia' ? recordEmbed.media : recordEmbed;
    const view = viewEmbed?.$type === 'app.bsky.embed.recordWithMedia#view' ? viewEmbed.media : viewEmbed;
    if (record?.$type === 'app.bsky.embed.images') {
      (record.images ?? []).forEach((image, index) => {
        const url = this.blobUrl(image.image) ?? view?.images?.[index]?.fullsize;
        if (!url) return;
        const alt = typeof image.alt === 'string' && image.alt.trim() ? image.alt.trim() : undefined;
        out.push({ url, mimeType: image.image?.mimeType ?? 'image/jpeg', ...(alt ? { alt } : {}) });
      });
    } else if (record?.$type === 'app.bsky.embed.video') {
      const url = this.blobUrl(record.video);
      if (url) {
        const alt = typeof record.alt === 'string' && record.alt.trim() ? record.alt.trim() : undefined;
        out.push({ url, mimeType: record.video?.mimeType ?? 'video/mp4', ...(alt ? { alt } : {}) });
      }
    }
    return out;
  }

  private mapFeedItem(item: AtprotoFeedItem, context: SourceReadContext<PageCursor>): SourceItem | SkippedItem | null {
    const post = item.post;
    if (!post || typeof post.uri !== 'string') return null;
    const reasonType = item.reason?.$type;

    // A pinned post is repeated at the top of the feed; it is imported where it
    // actually sits chronologically, not here.
    if (reasonType === 'app.bsky.feed.defs#reasonPin') return null;

    if (reasonType === 'app.bsky.feed.defs#reasonRepost') {
      const sourceId = item.reason?.uri ?? `${post.uri}#repost:${this.did}`;
      if (!context.options.includeBoosts) return { kind: 'skipped', sourceId, reason: 'boost-disabled' };
      const parsed = parseAtUri(post.uri);
      const createdAt = parseCreatedAt(item.reason?.indexedAt) ?? parseCreatedAt(post.indexedAt);
      if (!parsed || !createdAt) return { kind: 'skipped', sourceId, reason: 'unsupported' };
      const url = bskyPostUrl(post.author?.handle || parsed.authority, parsed.rkey);
      return {
        kind: 'boost',
        sourceId,
        sourceUrl: url,
        createdAt: createdAt.toISOString(),
        text: url,
        visibility: 'public',
        media: [],
        links: [url],
      };
    }

    const parsed = parseAtUri(post.uri);
    const record = post.record;
    if (!parsed || parsed.collection !== POST_COLLECTION || post.author?.did !== this.did) return null;
    if (!record || record.$type !== POST_COLLECTION) return null;

    const links: string[] = [];
    let replyToSourceId: string | undefined;
    const parentUri = record.reply?.parent?.uri;
    const rootUri = record.reply?.root?.uri;
    if (parentUri) {
      const parentIsSelf = parseAtUri(parentUri)?.authority === this.did;
      const rootIsSelf = !rootUri || parseAtUri(rootUri)?.authority === this.did;
      if (parentIsSelf && rootIsSelf) replyToSourceId = parentUri;
      else if (!context.options.includeRepliesToOthers) {
        return { kind: 'skipped', sourceId: post.uri, reason: 'reply-to-other' };
      } else {
        const parent = parseAtUri(parentUri);
        if (parent) links.push(bskyPostUrl(parent.authority, parent.rkey));
      }
    }

    let quoteSourceId: string | undefined;
    const quoted = extractQuoted(post.embed);
    if (quoted) {
      if (quoted.authorDid === this.did) quoteSourceId = quoted.uri;
      else {
        const target = parseAtUri(quoted.uri);
        if (target) links.push(bskyPostUrl(quoted.authorHandle || target.authority, target.rkey));
      }
    }
    if (record.embed?.$type === 'app.bsky.embed.external' && typeof record.embed.external?.uri === 'string') {
      links.push(record.embed.external.uri);
    }

    const createdAt = parseCreatedAt(record.createdAt) ?? parseCreatedAt(post.indexedAt);
    if (!createdAt) return { kind: 'skipped', sourceId: post.uri, reason: 'unsupported' };

    const text = normalizeMultilineText(applyFacetReplacements(typeof record.text === 'string' ? record.text : '', buildFacetReplacements(record)));
    const media = this.media(record.embed, post.embed);
    if (!text && media.length === 0 && links.length === 0) return { kind: 'skipped', sourceId: post.uri, reason: 'empty' };

    const labels = adultLabels(record);
    const contentWarning = labels.length > 0 ? labels.map((label) => LABEL_WARNINGS[label] ?? label).join(', ') : undefined;
    const language = normalizeLangs(record.langs)[0];

    return {
      kind: 'post',
      sourceId: post.uri,
      sourceUrl: bskyPostUrl(post.author?.handle || this.did, parsed.rkey),
      createdAt: createdAt.toISOString(),
      text,
      ...(contentWarning ? { contentWarning, sensitive: true } : {}),
      ...(language ? { language } : {}),
      visibility: 'public',
      ...(replyToSourceId ? { replyToSourceId } : {}),
      ...(quoteSourceId ? { quoteSourceId } : {}),
      media,
      ...(links.length > 0 ? { links: [...new Set(links)] } : {}),
    };
  }
}
