/**
 * Mention as a content destination: the HTTP client for its ingest API.
 *
 * The wire contract lives in `mentionContract.ts`; this file is transport only —
 * the service token, `X-Oxy-User-Id`, status handling. Move writes content as a
 * first-party `internal`-tier Oxy app acting for the user (plan: "Autorización
 * hacia Mention"), so the ONLY identity on the request is Move's service token
 * plus the user id header; Mention checks the token belongs to Oxy Move.
 */

import type { OxyServer } from '@oxy.so/core/server';
import { parseRetryAfterMs } from '../sources/http';
import {
  MENTION_BATCH_MAX_ITEMS,
  MENTION_LOOKUP_MAX_IDS,
  MENTION_MAX_ALT,
  MENTION_MAX_CONTENT_WARNING,
  MENTION_MAX_LINKS,
  MENTION_MAX_MEDIA,
  MENTION_MAX_TEXT,
  MENTION_MAX_URL,
  mentionBatchRequestSchema,
  mentionBatchResponseSchema,
  mentionLookupResponseSchema,
  mentionUndoResponseSchema,
  splitBySize,
  type MentionImportItem,
} from './mentionContract';
import {
  DestinationRateLimitedError,
  DestinationRejectedError,
  type ContentDestination,
  type DeliveryResult,
  type PreparedItem,
  type UndoResult,
} from './types';

export interface MentionDestinationDeps {
  baseUrl: string;
  /** The Oxy client whose service token authenticates Move. */
  oxy: Pick<OxyServer, 'serviceToken'>;
  fetch?: typeof fetch;
}

/** When a source flagged a post sensitive without writing a warning. */
const DEFAULT_SENSITIVE_WARNING = 'Sensitive content';

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && value.length <= MENTION_MAX_URL;
}

/**
 * Map a prepared item onto Mention's item schema, clamping to its limits so one
 * item can never make Mention refuse the whole batch with a 400:
 * - visibility: `unlisted` becomes `public` (Mention's own ActivityPub rule; it
 *   has no unlisted), `followers` becomes `followers_only`;
 * - a content warning longer than 500 is cut; alt text to 4000;
 * - media and links to 10 each, links to http(s) ≤ 2048;
 * - text to Mention's limit, which counts the links it appends;
 * - an article becomes `{ title, body }` with its body out of `text`.
 */
export function toMentionItem(item: PreparedItem): MentionImportItem {
  const warning = item.contentWarning ?? (item.sensitive ? DEFAULT_SENSITIVE_WARNING : undefined);
  const contentWarning = warning?.trim().slice(0, MENTION_MAX_CONTENT_WARNING) || undefined;
  const links = (item.links ?? []).filter(isHttpUrl).slice(0, MENTION_MAX_LINKS);
  const textBudget = MENTION_MAX_TEXT - links.reduce((total, link) => total + link.length + 1, 0);
  const text = item.article ? (item.article.summary ?? '') : item.text;
  return {
    sourceId: item.sourceId,
    sourceUrl: item.sourceUrl,
    createdAt: item.createdAt,
    text: text.slice(0, textBudget),
    ...(contentWarning ? { contentWarning } : {}),
    ...(item.language ? { language: item.language } : {}),
    visibility: item.visibility === 'followers' ? 'followers_only' : 'public',
    ...(item.replyToSourceId ? { replyToSourceId: item.replyToSourceId } : {}),
    ...(item.quoteSourceId ? { quoteSourceId: item.quoteSourceId } : {}),
    media: item.media.slice(0, MENTION_MAX_MEDIA).map((media) => ({
      assetId: media.assetId,
      ...(media.alt ? { alt: media.alt.slice(0, MENTION_MAX_ALT) } : {}),
    })),
    ...(item.article ? { article: { title: item.article.title, body: item.text } } : {}),
    ...(links.length > 0 ? { links } : {}),
  };
}

export class MentionDestination implements ContentDestination {
  readonly name = 'mention' as const;
  readonly maxBatchSize = MENTION_BATCH_MAX_ITEMS;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: MentionDestinationDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    oxyUserId: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.deps.oxy.serviceToken();
    const response = await this.fetchImpl(`${this.deps.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Oxy-User-Id': oxyUserId,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status === 429) {
      throw new DestinationRateLimitedError(
        'Mention is rate limiting imports',
        parseRetryAfterMs(response.headers.get('retry-after') ?? undefined) ?? 60_000,
      );
    }
    if (response.status >= 500) {
      // Transient: the job attempt fails and BullMQ retries it from the cursor.
      throw new Error(`Mention ${method} ${path} answered ${response.status}`);
    }
    if (!response.ok) {
      throw new DestinationRejectedError(
        `Mention ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
    }
    return text.length > 0 ? JSON.parse(text) : {};
  }

  /** Deliver in order, split into requests of ≤ 50 items and ≤ ~0.9 MB each. */
  async deliver(params: {
    oxyUserId: string;
    platform: 'mastodon' | 'bluesky';
    batchId: string;
    items: PreparedItem[];
  }): Promise<DeliveryResult[]> {
    const out: DeliveryResult[] = [];
    for (const chunk of splitBySize(params.items.map(toMentionItem))) {
      const payload = mentionBatchRequestSchema.parse({
        platform: params.platform,
        batchId: params.batchId,
        items: chunk,
      });
      const raw = await this.request('POST', '/imports/v1/posts:batch', params.oxyUserId, payload);
      const parsed = mentionBatchResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DestinationRejectedError(
          `Mention batch response did not match the contract: ${parsed.error.message}`,
          200,
        );
      }
      const bySource = new Map(parsed.data.results.map((result) => [result.sourceId, result]));
      // Every item sent gets an answer; one Mention forgot is a failure, not a success.
      for (const item of chunk) {
        const result = bySource.get(item.sourceId);
        if (!result) {
          out.push({ sourceId: item.sourceId, status: 'failed', error: 'missing-from-response' });
        } else if (
          (result.status === 'created' || result.status === 'existing') &&
          !result.postId
        ) {
          out.push({ sourceId: item.sourceId, status: 'failed', error: 'no-post-id' });
        } else {
          out.push({
            sourceId: item.sourceId,
            status: result.status,
            ...(result.postId ? { destinationId: result.postId } : {}),
            ...(result.error ? { error: result.error } : {}),
          });
        }
      }
    }
    return out;
  }

  async undo(params: { oxyUserId: string; batchId: string }): Promise<UndoResult> {
    const raw = await this.request(
      'DELETE',
      `/imports/v1/batches/${encodeURIComponent(params.batchId)}`,
      params.oxyUserId,
    );
    return mentionUndoResponseSchema.parse(raw);
  }

  /** The source ids of this user + platform Mention already imported (any batch). */
  async lookupImported(params: {
    oxyUserId: string;
    platform: 'mastodon' | 'bluesky';
    sourceIds: string[];
  }): Promise<Set<string>> {
    const found = new Set<string>();
    const unique = [...new Set(params.sourceIds)];
    for (let start = 0; start < unique.length; start += MENTION_LOOKUP_MAX_IDS) {
      const query = new URLSearchParams({ platform: params.platform });
      // Repeated parameters (Mention accepts repeated or comma-joined; its `queryList` splits on commas either way).
      for (const sourceId of unique.slice(start, start + MENTION_LOOKUP_MAX_IDS))
        query.append('sourceIds', sourceId);
      const raw = await this.request(
        'GET',
        `/imports/v1/lookup?${query.toString()}`,
        params.oxyUserId,
      );
      for (const sourceId of Object.keys(mentionLookupResponseSchema.parse(raw).imported))
        found.add(sourceId);
    }
    return found;
  }
}
