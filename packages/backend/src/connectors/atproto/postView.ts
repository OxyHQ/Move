// Provenance: copied from OxyHQ/Mention packages/backend/src/connectors/atproto/post.mapper.ts
// and profile.mapper.ts @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main).
// Only the PURE readers a migrator needs: the response shapes, the facet splice
// and the quote/label/language readers. Mention's normalizers, database and
// identity bridge stay behind. Bodies are unchanged except where a comment says
// CHANGED.

import { clampFutureDate } from '../../utils/ingestTimestamp';

/** The atproto record collection that holds a feed post. */
export const POST_COLLECTION = 'app.bsky.feed.post';

/** Adult/sensitive self-label values that flip a post's content warning on. */
const ADULT_LABEL_VALUES = new Set(['porn', 'nudity', 'sexual', 'graphic-media']);

/** Clamp self-asserted future timestamps (atproto `createdAt` is author-supplied). */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000; // 1 hour

interface AtprotoFacetFeature {
  $type?: string;
  tag?: string;
  uri?: string;
  did?: string;
}
interface AtprotoFacetIndex {
  byteStart?: number;
  byteEnd?: number;
}
interface AtprotoFacet {
  index?: AtprotoFacetIndex;
  features?: AtprotoFacetFeature[];
}
interface AtprotoReplyRef {
  uri?: string;
  cid?: string;
}
/** A blob reference as it appears in a RECORD (not a view). */
export interface AtprotoBlobRef {
  $type?: string;
  ref?: { $link?: string };
  /** Legacy blob shape. */
  cid?: string;
  mimeType?: string;
  size?: number;
}
/** The `embed` of a post RECORD — blob refs, not CDN URLs. */
export interface AtprotoRecordEmbed {
  $type?: string;
  images?: Array<{ image?: AtprotoBlobRef; alt?: string }>;
  video?: AtprotoBlobRef;
  alt?: string;
  media?: AtprotoRecordEmbed;
  record?: { uri?: string; record?: { uri?: string } };
  external?: { uri?: string; title?: string };
}
interface AtprotoPostRecord {
  $type?: string;
  text?: string;
  createdAt?: string;
  reply?: { root?: AtprotoReplyRef; parent?: AtprotoReplyRef };
  facets?: AtprotoFacet[];
  langs?: string[];
  tags?: string[];
  labels?: { values?: Array<{ val?: string }> };
  embed?: AtprotoRecordEmbed;
}
interface AtprotoEmbedImage {
  thumb?: string;
  fullsize?: string;
  alt?: string;
  aspectRatio?: { width: number; height: number };
}
interface AtprotoEmbedRecordView {
  $type?: string;
  uri?: string;
  author?: { did?: string; handle?: string };
  record?: AtprotoEmbedRecordView;
}
export interface AtprotoEmbedView {
  $type?: string;
  images?: AtprotoEmbedImage[];
  playlist?: string;
  thumbnail?: string;
  aspectRatio?: { width: number; height: number };
  media?: AtprotoEmbedView;
  record?: AtprotoEmbedRecordView;
}
export interface AtprotoPostView {
  uri?: string;
  cid?: string;
  author?: { did?: string; handle?: string };
  record?: AtprotoPostRecord;
  embed?: AtprotoEmbedView;
  indexedAt?: string;
}
export interface AtprotoFeedItem {
  post?: AtprotoPostView;
  reason?: { $type?: string; uri?: string; indexedAt?: string; by?: { did?: string } };
}
export interface AtprotoAuthorFeed {
  feed?: AtprotoFeedItem[];
  cursor?: string;
}

/** Parse an AT-URI `at://<authority>/<collection>/<rkey>` into its parts. */
export function parseAtUri(uri: string): { authority: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { authority: match[1], collection: match[2], rkey: match[3] };
}

export function parseCreatedAt(value: unknown): Date | undefined {
  return clampFutureDate(value, MAX_FUTURE_SKEW_MS);
}

interface FacetReplacement {
  byteStart: number;
  byteEnd: number;
  replacement: string;
}

/**
 * Byte-range replacements for a record's `#link` facets: the display text
 * (often truncated) becomes the FULL `uri`. CHANGED: mentions are left as the
 * author wrote them — an imported `@handle` is never re-pointed at an Oxy account.
 */
export function buildFacetReplacements(record: AtprotoPostRecord): FacetReplacement[] {
  const ops: FacetReplacement[] = [];
  for (const facet of record.facets ?? []) {
    const byteStart = facet.index?.byteStart;
    const byteEnd = facet.index?.byteEnd;
    if (typeof byteStart !== 'number' || typeof byteEnd !== 'number') continue;
    const link = facet.features?.find((feature) => feature?.$type === 'app.bsky.richtext.facet#link');
    if (typeof link?.uri === 'string' && link.uri) ops.push({ byteStart, byteEnd, replacement: link.uri });
  }
  return ops;
}

/** Apply byte-range replacements (UTF-8 offsets, descending, overlap-safe). */
export function applyFacetReplacements(text: string, ops: FacetReplacement[]): string {
  if (ops.length === 0) return text;
  const buffer = Buffer.from(text, 'utf8');
  const ordered = ops
    .filter((op) => op.byteStart >= 0 && op.byteStart < op.byteEnd && op.byteEnd <= buffer.length)
    .sort((a, b) => b.byteStart - a.byteStart);

  let out = buffer;
  let nextStart = buffer.length;
  for (const op of ordered) {
    if (op.byteEnd > nextStart) continue;
    out = Buffer.concat([out.subarray(0, op.byteStart), Buffer.from(op.replacement, 'utf8'), out.subarray(op.byteEnd)]);
    nextStart = op.byteStart;
  }
  return out.toString('utf8');
}

/**
 * The quoted post's AT-URI and author DID from a hydrated record embed — only
 * for a real, viewable feed post. CHANGED: also returns the quoted author's DID,
 * which a migrator needs to tell a SELF-quote from a quote of someone else.
 */
export function extractQuoted(embed: AtprotoEmbedView | undefined): { uri: string; authorDid?: string; authorHandle?: string } | undefined {
  const recordView =
    embed?.$type === 'app.bsky.embed.record#view'
      ? embed.record
      : embed?.$type === 'app.bsky.embed.recordWithMedia#view'
        ? embed.record?.record
        : undefined;
  if (recordView?.$type === 'app.bsky.embed.record#viewRecord' && typeof recordView.uri === 'string') {
    const parsed = parseAtUri(recordView.uri);
    if (parsed && parsed.collection === POST_COLLECTION) {
      return { uri: recordView.uri, authorDid: recordView.author?.did ?? parsed.authority, authorHandle: recordView.author?.handle };
    }
  }
  return undefined;
}

/** Normalize `record.langs` to ISO 639-1 primary subtags (deduped, capped at 3). */
export function normalizeLangs(langs: unknown): string[] {
  if (!Array.isArray(langs)) return [];
  const out: string[] = [];
  for (const lang of langs) {
    if (typeof lang !== 'string') continue;
    const code = lang.trim().toLowerCase().split('-')[0];
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= 3) break;
  }
  return out;
}

/** The adult self-labels a record carries (subset of {@link ADULT_LABEL_VALUES}). */
export function adultLabels(record: AtprotoPostRecord): string[] {
  const values = record.labels?.values;
  if (!Array.isArray(values)) return [];
  return values
    .map((entry) => entry?.val)
    .filter((value): value is string => typeof value === 'string' && ADULT_LABEL_VALUES.has(value));
}

/** The web URL of a post. */
export function bskyPostUrl(handleOrDid: string, rkey: string): string {
  return `https://bsky.app/profile/${handleOrDid}/post/${rkey}`;
}

/** The subset of `app.bsky.actor.defs#profileViewDetailed` this connector reads. */
export interface AtprotoProfileView {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
}
