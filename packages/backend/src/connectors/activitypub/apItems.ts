// Provenance: split out of OxyHQ/Mention packages/backend/src/connectors/activitypub/helpers.ts,
// outbox.service.ts and apPostContent.ts @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main).
// Only the PURE pieces: every database import (posts, getDb, actor repository),
// the post-id resolvers and the Mention media materializer stay behind. Bodies
// are unchanged unless a comment below says otherwise.

import { extractActorUriFromActivityId } from '@oxy.so/federation';
import { clampFutureDate } from '../../utils/ingestTimestamp';
import { htmlToInlineLabel } from '../../utils/htmlToPlainText';
import { isAbsoluteHttpUrl } from '../../utils/url';
import { extractApLanguage, getApContentMap } from './apLanguage';

/** The `Accept` every ActivityPub GET sends. */
export const AP_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

/** The Public collection IRI. */
const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function activityPubItems(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.orderedItems)) return value.orderedItems;
  if (Array.isArray(value.items)) return value.items;
  return [];
}

export function activityPubLinkUrl(value: unknown): string | null {
  if (typeof value === 'string' && isAbsoluteHttpUrl(value)) return value;
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id === 'string' && isAbsoluteHttpUrl(record.id)) return record.id;
  if (typeof record.href === 'string' && isAbsoluteHttpUrl(record.href)) return record.href;
  return null;
}

export function firstStringUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && isAbsoluteHttpUrl(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = firstStringUrl(item);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstStringUrl(record.url) || firstStringUrl(record.href);
  }
  return undefined;
}

/**
 * Tolerance window for a federated post's `published` date being slightly ahead
 * of our clock. A small skew between instances is normal; anything beyond this
 * is treated as a bogus future date and rejected.
 */
const AP_PUBLISHED_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Parse an ActivityPub `published` value into a `Date`. Returns `undefined` when
 * missing, unparseable, or implausibly far in the future.
 */
export function parseApPublished(published: unknown): Date | undefined {
  return clampFutureDate(published, AP_PUBLISHED_MAX_FUTURE_SKEW_MS);
}

/**
 * Extract the announced object URI from an Announce activity's `object`,
 * which may be a plain URI string or an embedded object with an `id`.
 */
export function extractAnnouncedObjectUri(object: unknown): string | undefined {
  if (typeof object === 'string') return isAbsoluteHttpUrl(object) ? object : undefined;
  if (object && typeof object === 'object' && 'id' in object) {
    const id = (object as { id?: unknown }).id;
    return typeof id === 'string' && isAbsoluteHttpUrl(id) ? id : undefined;
  }
  return undefined;
}

/** Extract the actor URI from an AP attributedTo/actor value (string or `{id}`). */
export function extractActorUri(attributedTo: unknown): string | undefined {
  if (typeof attributedTo === 'string') return attributedTo;
  if (attributedTo && typeof attributedTo === 'object' && 'id' in attributedTo) {
    const id = (attributedTo as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/** Normalize an AP `inReplyTo` (IRI, or embedded Link/object with `id`/`href`). */
export function extractInReplyToUri(inReplyTo: unknown): string | undefined {
  if (typeof inReplyTo === 'string') {
    const trimmed = inReplyTo.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (inReplyTo && typeof inReplyTo === 'object') {
    const record = inReplyTo as { id?: unknown; href?: unknown };
    if (typeof record.id === 'string' && record.id.trim().length > 0) return record.id.trim();
    if (typeof record.href === 'string' && record.href.trim().length > 0) return record.href.trim();
  }
  return undefined;
}

/**
 * The canonical AP object URI of the post a Note QUOTES: the modern
 * `quote`/`quoteUri` (FEP-044f / Mastodon 4.4+), the legacy
 * `_misskey_quote`/`quoteUrl`, and the FEP-e232 `Link` quote tag.
 */
export function extractApQuoteUri(object: Record<string, unknown>): string | undefined {
  for (const key of ['quote', 'quoteUri', 'quoteUrl', '_misskey_quote'] as const) {
    const uri = activityPubLinkUrl(object[key]);
    if (uri) return uri;
  }

  const tags = object.tag;
  if (Array.isArray(tags)) {
    for (const entry of tags) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as {
        type?: unknown;
        rel?: unknown;
        mediaType?: unknown;
        href?: unknown;
      };
      const isLink =
        record.type === 'Link' || (Array.isArray(record.type) && record.type.includes('Link'));
      if (!isLink) continue;

      const rel = Array.isArray(record.rel)
        ? record.rel.join(' ')
        : typeof record.rel === 'string'
          ? record.rel
          : '';
      const isQuoteRel = rel.includes('_misskey_quote');
      const isApLink =
        typeof record.mediaType === 'string' &&
        record.mediaType.toLowerCase().includes('activity+json');
      if (!isQuoteRel && !isApLink) continue;

      const href = typeof record.href === 'string' ? record.href.trim() : '';
      if (href && isAbsoluteHttpUrl(href)) return href;
    }
  }

  return undefined;
}

function addressees(to?: unknown, cc?: unknown): { to: unknown[]; cc: unknown[] } {
  const asList = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : value === undefined ? [] : [value];
  return { to: asList(to), cc: asList(cc) };
}

/**
 * Mastodon's visibility, read back off the addressing. Mention collapses
 * public+unlisted into "public" (its `mapApVisibility`); a migrator must not,
 * because an unlisted post was deliberately kept out of public timelines.
 *
 * CHANGED from Mention's `isPubliclyAddressed`: that one read only ARRAY `to`/`cc`,
 * so a bare-string `to: "…#Public"` (legal AS2, emitted by some servers) read as
 * followers-only. Both shapes are accepted here.
 */
export function apVisibility(to?: unknown, cc?: unknown): 'public' | 'unlisted' | 'followers' {
  const lists = addressees(to, cc);
  if (lists.to.includes(AS_PUBLIC)) return 'public';
  if (lists.cc.includes(AS_PUBLIC)) return 'unlisted';
  return 'followers';
}

// --- from outbox.service.ts -------------------------------------------------

export function isSameOriginHttpUrl(value: string, sourceUrl: string): boolean {
  if (!isAbsoluteHttpUrl(value) || !isAbsoluteHttpUrl(sourceUrl)) return false;
  try {
    return new URL(value).origin === new URL(sourceUrl).origin;
  } catch {
    return false;
  }
}

function normalizeActorUriForCompare(uri: string | null | undefined): string | null {
  if (!uri || !isAbsoluteHttpUrl(uri)) return null;
  try {
    const parsed = new URL(uri);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return null;
  }
}

export function actorUrisMatch(actual: string | null | undefined, expected: string): boolean {
  const normalizedActual = normalizeActorUriForCompare(actual);
  const normalizedExpected = normalizeActorUriForCompare(expected);
  return Boolean(normalizedActual && normalizedExpected && normalizedActual === normalizedExpected);
}

export function activityIdBelongsToActor(activityId: string, actorUri: string): boolean {
  if (!isAbsoluteHttpUrl(activityId)) return false;

  try {
    const activityUrl = new URL(activityId);
    const actorUrl = new URL(actorUri);
    if (activityUrl.origin !== actorUrl.origin) return false;
  } catch {
    return false;
  }

  const derivedActorUri = extractActorUriFromActivityId(activityId);
  return !derivedActorUri || actorUrisMatch(derivedActorUri, actorUri);
}

// --- from apPostContent.ts --------------------------------------------------

/**
 * The HTML body of an AP object: top-level `content`, else the `contentMap`
 * variant for the declared primary language, else the first non-empty variant.
 */
export function extractApContentHtml(object: Record<string, unknown> | null | undefined): string {
  if (!object || typeof object !== 'object') return '';

  const content = object.content;
  if (typeof content === 'string' && content.trim().length > 0) return content;

  const contentMap = getApContentMap(object);
  if (!contentMap) return '';

  const preferred = extractApLanguage(object);
  if (preferred) {
    for (const [key, value] of Object.entries(contentMap)) {
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      const primary = key.trim().toLowerCase().split('-')[0];
      if (primary === preferred) return value;
    }
  }

  for (const value of Object.values(contentMap)) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }

  return '';
}

/** The content warning: an AP `summary`, normalized to one plain-text line. */
export function extractApSummary(
  object: Record<string, unknown> | null | undefined,
): string | undefined {
  return htmlToInlineLabel(object?.summary);
}
