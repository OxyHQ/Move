/**
 * The source contract: what every platform reader produces, and nothing about
 * where it goes.
 *
 * A source reads ONE external account's public content, profile and follow
 * list. It knows nothing about Oxy, Mention or the database; the pipeline owns
 * checkpoints, deferral and destinations.
 *
 * `SourceItem` is deliberately the shape of Mention's ingest item
 * (`POST /imports/v1/posts:batch`) minus the destination-only fields (the Oxy
 * asset id a media entry gains after upload is added by the destination).
 */

import type { JobOptions, MigrationPlatform } from '@move/shared-types';

export type SourceVisibility = 'public' | 'unlisted' | 'followers';

export interface SourceMedia {
  /** Where the ORIGINAL bytes can be fetched (never a thumbnail or HLS playlist). */
  url: string;
  mimeType: string;
  alt?: string;
}

export interface SourceArticle {
  title: string;
  summary?: string;
}

export type SourceItemKind = 'post' | 'article' | 'boost';

export interface SourceItem {
  kind: SourceItemKind;
  /** Stable source id: AS2 object id (Mastodon) or AT-URI (Bluesky). */
  sourceId: string;
  /** Human-facing URL on the source platform. */
  sourceUrl: string;
  /** ISO 8601 original creation time. */
  createdAt: string;
  text: string;
  contentWarning?: string;
  /** The source flagged the post sensitive without writing a warning. */
  sensitive?: boolean;
  /** ISO 639-1 primary subtag. */
  language?: string;
  visibility: SourceVisibility;
  /** Parent's source id — only ever the SAME author's post (self-thread). */
  replyToSourceId?: string;
  /** Quoted post's source id — only when the author quotes THEMSELVES. */
  quoteSourceId?: string;
  media: SourceMedia[];
  article?: SourceArticle;
  /** URLs that carry meaning the text alone would lose (a foreign quote, a boost). */
  links?: string[];
}

export interface SourceProfile {
  /** Actor URI (ActivityPub) or DID (atproto). */
  actor: string;
  handle: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  links?: string[];
  postsCount?: number;
  followingCount?: number;
  followersCount?: number;
  /** The follow list is hidden by its owner (Mastodon `hide_collections`); the graph phase then skips. */
  graphHidden?: boolean;
}

/** An account the source user follows — or blocks, where blocks are public. */
export interface GraphAccount {
  /** Actor URI or DID — what Oxy's identity registry keys on. */
  actor: string;
  handle?: string;
  /** Absent means `follow`. Only sources whose block list is public yield `block`. */
  relation?: 'follow' | 'block';
}

export interface Positioned<T, TCursor> {
  value: T;
  /** Resumes AFTER this value. Persisting it and restarting never re-yields it. */
  cursor: TCursor;
}

export interface SourceReadContext<TCursor> {
  /** Resume point; null starts from the beginning (newest first). */
  cursor: TCursor | null;
  options: JobOptions;
}

/** The account a source reads, as Oxy's linked-account registry vouches for it. */
export interface SourceAccount {
  platform: MigrationPlatform;
  /** Actor URI (Mastodon) or DID (Bluesky). */
  actor: string;
  handle: string;
}

export interface Source<TContentCursor = unknown, TGraphCursor = unknown> {
  readonly platform: MigrationPlatform;
  profile(): Promise<SourceProfile>;
  /**
   * Every item worth considering, newest first. Filtering by option (replies to
   * others, boosts) happens HERE; each yielded value is either an item or a
   * `skip` so the pipeline can count what it did not import and still advance
   * the cursor past it.
   */
  items(
    context: SourceReadContext<TContentCursor>,
  ): AsyncIterable<Positioned<SourceItem | SkippedItem, TContentCursor>>;
  /** Followed accounts, then (where public) blocked accounts, resumable across both. */
  graph(
    context: SourceReadContext<TGraphCursor>,
  ): AsyncIterable<Positioned<GraphAccount, TGraphCursor>>;
  /** Newest and (if cheaply known) oldest item timestamps, for the preview. */
  dateRange?(): Promise<{ newestAt?: string; oldestAt?: string }>;
}

export interface SkippedItem {
  kind: 'skipped';
  sourceId: string;
  reason: 'reply-to-other' | 'boost-disabled' | 'not-public' | 'unsupported' | 'empty';
}

export function isSkipped(value: SourceItem | SkippedItem): value is SkippedItem {
  return value.kind === 'skipped';
}
