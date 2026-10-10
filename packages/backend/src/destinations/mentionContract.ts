/**
 * THE contract with Mention's ingest API — one module, zod on both sides.
 *
 * Source of truth: Mention `docs/import.mdx` and `packages/backend/src/routes/imports.ts`
 * (the `itemSchema` / `batchSchema` / `lookupSchema` there), read at Mention's
 * `e0ee03747 docs(imports): the content-import contract for Oxy Move`. The
 * request schema below MIRRORS Mention's field by field, including its limits,
 * so an item Mention would refuse with `400 INVALID_IMPORT_BATCH` (which refuses
 * the WHOLE batch) is caught here instead.
 *
 *   POST   {MENTION_API_URL}/imports/v1/posts:batch   { platform, batchId, items ≤ 50 }, body ≤ 1 MB
 *          → { results: [{ sourceId, status: created|existing|deferred|failed, postId?, error? }] }
 *   DELETE {MENTION_API_URL}/imports/v1/batches/:batchId
 *          → { deleted, failed }
 *   GET    {MENTION_API_URL}/imports/v1/lookup?platform=&sourceIds=a,b   (≤ 200)
 *          → { imported: { sourceId: postId }, federated: {…} }
 *
 * Auth on every call: Move's Oxy SERVICE token plus `X-Oxy-User-Id`. Mention
 * admits only the application whose id is its `MOVE_APPLICATION_ID`.
 */

import { z } from 'zod';
import { MIGRATION_PLATFORMS } from '@move/shared-types';

/** `MAX_IMPORT_BATCH_ITEMS`. */
export const MENTION_BATCH_MAX_ITEMS = 50;
/** Mention's JSON body limit is 1 MB per request; keep a margin for the envelope. */
const MENTION_BATCH_TARGET_BYTES = 900_000;
/** `MAX_IMPORT_MEDIA_PER_ITEM`, `MAX_IMPORT_LINKS_PER_ITEM`. */
export const MENTION_MAX_MEDIA = 10;
export const MENTION_MAX_LINKS = 10;
/** `config.posts.maxTextLength` (text + appended links). */
export const MENTION_MAX_TEXT = 25_000;
export const MENTION_MAX_CONTENT_WARNING = 500;
/** `config.posts.maxAltTextLength * 2`. */
export const MENTION_MAX_ALT = 4_000;
const MENTION_MAX_ID = 512;
export const MENTION_MAX_URL = 2_048;
/** `MAX_LOOKUP_IDS`. */
export const MENTION_LOOKUP_MAX_IDS = 200;

const opaqueId = z.string().trim().min(1).max(MENTION_MAX_ID);
const httpUrl = z
  .string()
  .trim()
  .max(MENTION_MAX_URL)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

/** Mention stores only these two; Move maps `unlisted` to `public` (Mention's own AP rule). */
const MENTION_VISIBILITIES = ['public', 'followers_only'] as const;

export const mentionImportItemSchema = z
  .object({
    sourceId: opaqueId,
    sourceUrl: httpUrl,
    createdAt: z.iso.datetime({ offset: true }),
    text: z.string().max(MENTION_MAX_TEXT),
    contentWarning: z.string().trim().max(MENTION_MAX_CONTENT_WARNING).optional(),
    language: z.string().trim().min(2).max(35).optional(),
    visibility: z.enum(MENTION_VISIBILITIES),
    replyToSourceId: opaqueId.optional(),
    quoteSourceId: opaqueId.optional(),
    media: z
      .array(
        z.object({ assetId: opaqueId, alt: z.string().max(MENTION_MAX_ALT).optional() }).strict(),
      )
      .max(MENTION_MAX_MEDIA),
    article: z
      .object({ title: z.string().optional(), body: z.string().optional() })
      .strict()
      .optional(),
    links: z.array(httpUrl).max(MENTION_MAX_LINKS).optional(),
  })
  .strict();

export const mentionBatchRequestSchema = z.object({
  platform: z.enum(MIGRATION_PLATFORMS),
  batchId: opaqueId,
  items: z.array(mentionImportItemSchema).min(1).max(MENTION_BATCH_MAX_ITEMS),
});

/** `error` carries Mention's code (`parent_not_imported`, `quote_not_imported`, …); unknown codes are accepted. */
const mentionBatchResultSchema = z.object({
  sourceId: z.string(),
  status: z.enum(['created', 'existing', 'deferred', 'failed']),
  postId: z.string().optional(),
  error: z.string().optional(),
});

export const mentionBatchResponseSchema = z.object({ results: z.array(mentionBatchResultSchema) });

export const mentionUndoResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/** Move sends only `sourceIds`, so only `imported` (sourceId → postId) is read. */
export const mentionLookupResponseSchema = z.object({ imported: z.record(z.string(), z.string()) });

export type MentionImportItem = z.infer<typeof mentionImportItemSchema>;

/**
 * Pack items into requests of ≤ {@link MENTION_BATCH_MAX_ITEMS} items AND ≤
 * {@link MENTION_BATCH_TARGET_BYTES} serialized bytes, preserving order (a
 * parent sent earlier in the list stays in an earlier or the same request).
 */
export function splitBySize<T>(
  items: T[],
  maxItems = MENTION_BATCH_MAX_ITEMS,
  maxBytes = MENTION_BATCH_TARGET_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (current.length > 0 && (current.length >= maxItems || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
