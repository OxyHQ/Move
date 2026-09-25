/**
 * Mastodon (and any ActivityPub server) as a Move source.
 *
 * Reads the linked actor's PUBLIC ActivityPub surface: the actor document
 * (profile), its outbox (content) and its `following` collection (graph). No
 * token is involved — Oxy's OAuth proved ownership and discarded the token.
 *
 * Reads are UNSIGNED: Move has no actor whose key a remote could fetch, and a
 * signature the remote cannot verify is refused like none. An instance in
 * authorized-fetch mode answers 401/403, which becomes
 * {@link SourceAuthRequiredError} (`source-requires-authorized-fetch`).
 *
 * Outbox paging and validation are Mention's (`outbox.service.ts`): every page
 * is zod-validated, `next` links must stay same-origin, a page URL is never
 * visited twice, a string item is only dereferenced same-origin, and a note is
 * only accepted when BOTH its `attributedTo` and its id belong to the actor —
 * so a hostile outbox cannot smuggle another account's posts into a migration.
 *
 * The content cursor is `{ pageUrl, itemOffset }`: Mastodon page URLs
 * (`?max_id=…&page=true`) are stable, so a restart re-fetches that page and
 * continues at the offset, and never re-yields an item it already yielded.
 */

import type { MigrationPlatform } from '@move/shared-types';
import { htmlToInlineLabel, htmlToPlainText } from '../utils/htmlToPlainText';
import { logger } from '../utils/logger';
import {
  AP_ACCEPT,
  activityIdBelongsToActor,
  activityPubItems,
  activityPubLinkUrl,
  actorUrisMatch,
  apVisibility,
  asRecord,
  extractActorUri,
  extractAnnouncedObjectUri,
  extractApContentHtml,
  extractApQuoteUri,
  extractApSummary,
  extractInReplyToUri,
  firstStringUrl,
  isSameOriginHttpUrl,
  parseApPublished,
} from '../connectors/activitypub/apItems';
import { extractApLanguage } from '../connectors/activitypub/apLanguage';
import { extractApMedia } from '../connectors/activitypub/apMedia';
import { isApActor, isApCollection, isApCollectionPage, isApNote, isApOutboxActivity } from '../connectors/activitypub/apSchemas';
import { SourceAuthRequiredError, SourceHttpError, type JsonFetcher } from './http';
import type {
  GraphAccount,
  Positioned,
  SkippedItem,
  Source,
  SourceAccount,
  SourceItem,
  SourceProfile,
  SourceReadContext,
} from './types';

export interface CollectionCursor {
  pageUrl: string;
  itemOffset: number;
}

/** Bounded pages per `items()`/`graph()` call chain; a runaway outbox cannot loop forever. */
const MAX_PAGES = 10_000;

/** Counts carried by an actor built from the REST lookup. */
function restCount(actor: Record<string, unknown>, key: 'posts' | 'following' | 'followers'): number | undefined {
  const counts = asRecord(actor._counts);
  const value = counts?.[key];
  return typeof value === 'number' ? value : undefined;
}

interface PageRef {
  url: string;
  inline?: Record<string, unknown>;
}

export class MastodonSource implements Source<CollectionCursor, CollectionCursor> {
  readonly platform: MigrationPlatform = 'mastodon';
  private actorDocument: Record<string, unknown> | null = null;

  constructor(
    private readonly account: SourceAccount,
    private readonly fetchJson: JsonFetcher,
  ) {}

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const response = await this.fetchJson(url, { accept: AP_ACCEPT });
    if (response.status === 401 || response.status === 403) {
      throw new SourceAuthRequiredError('the instance requires authorized (signed) fetch', response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SourceHttpError(`ActivityPub GET answered ${response.status}`, response.status);
    }
    const record = asRecord(response.body);
    if (!record) throw new SourceHttpError('ActivityPub GET returned a non-object', response.status);
    return record;
  }

  /** The actor document, verified to BE the linked account (not a redirect to another). */
  async actor(): Promise<Record<string, unknown>> {
    if (this.actorDocument) return this.actorDocument;
    let document: Record<string, unknown>;
    try {
      document = await this.getJson(this.account.actor);
      if (!isApActor(document)) throw new SourceHttpError('actor document failed validation', 200);
    } catch (error) {
      // MEASURED 2026-09-25: mastodon.social and hachyderm.io answer the ACTOR
      // document 401 "Request not signed" to an unsigned GET, while the same
      // account's outbox, statuses and `following` pages answer 200. So an
      // unsigned migrator can still read everything it needs: the profile comes
      // from Mastodon's public REST lookup and the collections sit at Mastodon's
      // fixed paths under the actor URI.
      if (!(error instanceof SourceAuthRequiredError)) throw error;
      document = await this.actorFromRestApi();
    }
    const id = typeof document.id === 'string' ? document.id : '';
    if (!actorUrisMatch(id, this.account.actor)) {
      throw new SourceHttpError('actor document id does not match the linked account', 200);
    }
    this.actorDocument = document;
    return document;
  }

  /**
   * An actor-shaped record built from `GET /api/v1/accounts/lookup` (public,
   * unsigned), verified to describe THIS actor (`uri` must equal it).
   */
  private async actorFromRestApi(): Promise<Record<string, unknown>> {
    const actorUrl = new URL(this.account.actor);
    const username = this.account.handle.replace(/^@/, '').split('@')[0];
    const lookupUrl = `${actorUrl.origin}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`;
    const response = await this.fetchJson(lookupUrl, { accept: 'application/json' });
    const account = asRecord(response.body);
    if (response.status !== 200 || !account) {
      throw new SourceAuthRequiredError('the actor needs a signed fetch and the REST lookup is unavailable', response.status);
    }
    if (typeof account.uri !== 'string' || !actorUrisMatch(account.uri, this.account.actor)) {
      throw new SourceHttpError('REST lookup answered for a different account', 200);
    }
    const fields = Array.isArray(account.fields) ? account.fields : [];
    const base = this.account.actor.replace(/\/+$/, '');
    return {
      id: this.account.actor,
      type: 'Person',
      name: account.display_name,
      summary: account.note,
      icon: typeof account.avatar === 'string' ? { type: 'Image', url: account.avatar } : undefined,
      attachment: fields
        .map((field) => asRecord(field))
        .filter((field): field is Record<string, unknown> => Boolean(field))
        .map((field) => ({ type: 'PropertyValue', name: field.name, value: field.value })),
      outbox: `${base}/outbox`,
      following: `${base}/following`,
      followers: `${base}/followers`,
      _counts: {
        posts: account.statuses_count,
        following: account.following_count,
        followers: account.followers_count,
      },
    };
  }

  async profile(): Promise<SourceProfile> {
    const actor = await this.actor();
    const following = await this.collectionHead(actor.following);
    const outbox = await this.collectionHead(actor.outbox);
    const followers = await this.collectionHead(actor.followers);
    const links: string[] = [];
    for (const field of Array.isArray(actor.attachment) ? actor.attachment : []) {
      const record = asRecord(field);
      if (record?.type !== 'PropertyValue' || typeof record.value !== 'string') continue;
      const url = htmlToPlainText(record.value);
      if (/^https?:\/\/\S+$/i.test(url)) links.push(url);
    }
    return {
      actor: this.account.actor,
      handle: this.account.handle,
      displayName: htmlToInlineLabel(actor.name),
      bio: typeof actor.summary === 'string' ? htmlToPlainText(actor.summary) || undefined : undefined,
      avatarUrl: firstStringUrl(actor.icon),
      links: links.length > 0 ? links : undefined,
      postsCount: outbox?.totalItems ?? restCount(actor, 'posts'),
      followingCount: following?.totalItems ?? restCount(actor, 'following'),
      followersCount: followers?.totalItems ?? restCount(actor, 'followers'),
      graphHidden: following?.hidden ?? false,
    };
  }

  /** `totalItems` of a collection and whether its items are hidden. Fail-soft. */
  private async collectionHead(ref: unknown): Promise<{ totalItems?: number; hidden: boolean } | null> {
    const url = activityPubLinkUrl(ref);
    if (!url) return null;
    try {
      const collection = await this.getJson(url);
      const totalItems = typeof collection.totalItems === 'number' ? collection.totalItems : undefined;
      const hasItems = Boolean(collection.first) || activityPubItems(collection).length > 0;
      return { totalItems, hidden: !hasItems && (totalItems ?? 0) > 0 };
    } catch (error) {
      logger.debug('[mastodon] collection head unavailable', error);
      return null;
    }
  }

  async dateRange(): Promise<{ newestAt?: string; oldestAt?: string }> {
    const actor = await this.actor();
    const outboxUrl = activityPubLinkUrl(actor.outbox);
    if (!outboxUrl) return {};
    const collection = await this.getJson(outboxUrl);
    const range: { newestAt?: string; oldestAt?: string } = {};
    const read = async (ref: unknown, pick: 'first' | 'last'): Promise<string | undefined> => {
      const inline = asRecord(ref);
      const url = activityPubLinkUrl(ref);
      const page = inline && activityPubItems(inline).length > 0 ? inline : url && isSameOriginHttpUrl(url, outboxUrl) ? await this.getJson(url) : null;
      if (!page) return undefined;
      const items = activityPubItems(page);
      const item = asRecord(pick === 'first' ? items[0] : items[items.length - 1]);
      const object = asRecord(item?.object);
      return parseApPublished(item?.published ?? object?.published)?.toISOString();
    };
    try {
      range.newestAt = await read(collection.first, 'first');
      range.oldestAt = await read(collection.last, 'last');
    } catch (error) {
      logger.debug('[mastodon] date range unavailable', error);
    }
    return range;
  }

  async *items(
    context: SourceReadContext<CollectionCursor>,
  ): AsyncIterable<Positioned<SourceItem | SkippedItem, CollectionCursor>> {
    const actor = await this.actor();
    const outboxUrl = activityPubLinkUrl(actor.outbox);
    if (!outboxUrl) return;
    for await (const { item, cursor, pageUrl } of this.walk(outboxUrl, context.cursor)) {
      const mapped = await this.mapOutboxItem(item, pageUrl, context);
      if (mapped) yield { value: mapped, cursor };
    }
  }

  async *graph(context: SourceReadContext<CollectionCursor>): AsyncIterable<Positioned<GraphAccount, CollectionCursor>> {
    const actor = await this.actor();
    const followingUrl = activityPubLinkUrl(actor.following);
    if (!followingUrl) return;
    for await (const { item, cursor } of this.walk(followingUrl, context.cursor)) {
      const uri = typeof item === 'string' ? item : extractActorUri(item);
      if (!uri || !/^https:\/\//i.test(uri)) continue;
      yield { value: { actor: uri }, cursor };
    }
  }

  /**
   * Walk an OrderedCollection page by page from `start` (or its first page),
   * yielding raw items with the cursor that resumes after each.
   */
  private async *walk(
    collectionUrl: string,
    start: CollectionCursor | null,
  ): AsyncIterable<{ item: unknown; cursor: CollectionCursor; pageUrl: string }> {
    let next: PageRef | null;
    let offset = start?.itemOffset ?? 0;
    if (start) {
      if (!isSameOriginHttpUrl(start.pageUrl, collectionUrl)) return;
      next = { url: start.pageUrl };
    } else {
      const collection = await this.getJson(collectionUrl);
      if (!isApCollection(collection)) {
        throw new SourceHttpError('collection failed validation', 200);
      }
      const inlineFirst = asRecord(collection.first);
      const firstUrl = activityPubLinkUrl(collection.first);
      if (activityPubItems(collection).length > 0) next = { url: collectionUrl, inline: collection };
      else if (inlineFirst && activityPubItems(inlineFirst).length > 0) {
        next = { url: firstUrl ?? collectionUrl, inline: inlineFirst };
      } else if (firstUrl) next = { url: firstUrl };
      else next = null;
    }

    const visited = new Set<string>();
    let pages = 0;
    while (next && pages < MAX_PAGES) {
      if (!isSameOriginHttpUrl(next.url, collectionUrl)) {
        logger.info('[mastodon] rejected cross-origin collection page');
        return;
      }
      const visitKey = next.inline ? `${next.url}#inline` : next.url;
      if (visited.has(visitKey)) {
        logger.info('[mastodon] collection pagination loop detected');
        return;
      }
      visited.add(visitKey);
      pages++;

      const page = next.inline ?? (await this.getJson(next.url));
      if (!next.inline && !isApCollectionPage(page)) {
        throw new SourceHttpError('collection page failed validation', 200);
      }
      const items = activityPubItems(page);
      const pageUrl = next.url;
      for (let index = Math.min(offset, items.length); index < items.length; index++) {
        yield { item: items[index], cursor: { pageUrl, itemOffset: index + 1 }, pageUrl };
      }
      offset = 0;
      const nextUrl = activityPubLinkUrl(page.next);
      next = nextUrl && isSameOriginHttpUrl(nextUrl, pageUrl) ? { url: nextUrl } : null;
    }
  }

  private async resolveRecord(item: unknown, pageUrl: string): Promise<Record<string, unknown> | null> {
    const inline = asRecord(item);
    if (inline) return inline;
    if (typeof item !== 'string' || !isSameOriginHttpUrl(item, pageUrl)) return null;
    try {
      return await this.getJson(item);
    } catch (error) {
      logger.debug('[mastodon] outbox item dereference failed', error);
      return null;
    }
  }

  private async mapOutboxItem(
    item: unknown,
    pageUrl: string,
    context: SourceReadContext<CollectionCursor>,
  ): Promise<SourceItem | SkippedItem | null> {
    const activity = await this.resolveRecord(item, pageUrl);
    if (!activity) return null;
    if (!isApOutboxActivity(activity) && !isApNote(activity)) return null;
    const actorUri = this.account.actor;
    const activityId = typeof activity.id === 'string' ? activity.id : '';

    if (activity.type === 'Announce') {
      const announcedUri = extractAnnouncedObjectUri(activity.object);
      if (!activityId || !announcedUri) return null;
      if (!actorUrisMatch(extractActorUri(activity.actor), actorUri)) return null;
      if (!activityIdBelongsToActor(activityId, actorUri)) return null;
      if (!context.options.includeBoosts) return { kind: 'skipped', sourceId: activityId, reason: 'boost-disabled' };
      const visibility = apVisibility(activity.to, activity.cc);
      if (visibility === 'followers') return { kind: 'skipped', sourceId: activityId, reason: 'not-public' };
      const createdAt = parseApPublished(activity.published);
      if (!createdAt) return { kind: 'skipped', sourceId: activityId, reason: 'unsupported' };
      return {
        kind: 'boost',
        sourceId: activityId,
        sourceUrl: announcedUri,
        createdAt: createdAt.toISOString(),
        text: announcedUri,
        visibility,
        media: [],
        links: [announcedUri],
      };
    }

    let note: Record<string, unknown> | null = null;
    if (activity.type === 'Note' || activity.type === 'Article' || activity.type === 'Question') note = activity;
    else if (activity.type === 'Create') note = await this.resolveRecord(activity.object, pageUrl);
    if (!note || !isApNote(note)) return null;
    if (note.type !== 'Note' && note.type !== 'Article' && note.type !== 'Question') {
      return activityId ? { kind: 'skipped', sourceId: activityId, reason: 'unsupported' } : null;
    }

    const noteId = typeof note.id === 'string' ? note.id : activityId;
    if (!noteId) return null;
    if (!actorUrisMatch(extractActorUri(note.attributedTo), actorUri)) return null;
    if (activity.type === 'Create' && !actorUrisMatch(extractActorUri(activity.actor), actorUri)) return null;
    if (!activityIdBelongsToActor(noteId, actorUri)) return null;

    const visibility = apVisibility(note.to ?? activity.to, note.cc ?? activity.cc);
    if (visibility === 'followers') return { kind: 'skipped', sourceId: noteId, reason: 'not-public' };

    const links: string[] = [];
    let replyToSourceId: string | undefined;
    const inReplyTo = extractInReplyToUri(note.inReplyTo);
    if (inReplyTo) {
      if (activityIdBelongsToActor(inReplyTo, actorUri)) replyToSourceId = inReplyTo;
      else if (!context.options.includeRepliesToOthers) {
        return { kind: 'skipped', sourceId: noteId, reason: 'reply-to-other' };
      } else links.push(inReplyTo);
    }

    let quoteSourceId: string | undefined;
    const quoteUri = extractApQuoteUri(note);
    if (quoteUri) {
      if (activityIdBelongsToActor(quoteUri, actorUri)) quoteSourceId = quoteUri;
      else links.push(quoteUri);
    }

    const createdAt = parseApPublished(note.published) ?? parseApPublished(activity.published);
    if (!createdAt) return { kind: 'skipped', sourceId: noteId, reason: 'unsupported' };

    const text = htmlToPlainText(extractApContentHtml(note));
    const media = extractApMedia(note);
    if (!text && media.length === 0) return { kind: 'skipped', sourceId: noteId, reason: 'empty' };

    const isArticle = note.type === 'Article';
    const title = isArticle ? htmlToInlineLabel(note.name) : undefined;
    const contentWarning = isArticle ? undefined : extractApSummary(note);
    const language = extractApLanguage(note);
    const sourceUrl = firstStringUrl(note.url) ?? noteId;

    return {
      kind: isArticle ? 'article' : 'post',
      sourceId: noteId,
      sourceUrl,
      createdAt: createdAt.toISOString(),
      text,
      ...(contentWarning ? { contentWarning } : {}),
      ...(note.sensitive === true ? { sensitive: true } : {}),
      ...(language ? { language } : {}),
      visibility,
      ...(replyToSourceId ? { replyToSourceId } : {}),
      ...(quoteSourceId ? { quoteSourceId } : {}),
      media,
      ...(isArticle ? { article: { title: title ?? '', ...(extractApSummary(note) ? { summary: extractApSummary(note) } : {}) } } : {}),
      ...(links.length > 0 ? { links } : {}),
    };
  }
}
