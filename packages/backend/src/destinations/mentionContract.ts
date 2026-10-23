/** Mention owns every schema and limit; Move only chooses its batch byte budget. */
export {
  MENTION_IMPORT_BATCH_MAX_ITEMS as MENTION_BATCH_MAX_ITEMS,
  MENTION_IMPORT_LOOKUP_MAX_IDS as MENTION_LOOKUP_MAX_IDS,
  MENTION_IMPORT_MAX_MEDIA as MENTION_MAX_MEDIA,
  MENTION_IMPORT_MAX_LINKS as MENTION_MAX_LINKS,
  MENTION_IMPORT_MAX_TEXT as MENTION_MAX_TEXT,
  MENTION_IMPORT_MAX_CONTENT_WARNING as MENTION_MAX_CONTENT_WARNING,
  MENTION_IMPORT_MAX_ALT as MENTION_MAX_ALT,
  MENTION_IMPORT_MAX_URL as MENTION_MAX_URL,
  mentionImportItemSchema,
  mentionImportBatchSchema as mentionBatchRequestSchema,
  mentionImportBatchResponseSchema as mentionBatchResponseSchema,
  mentionImportLookupResponseSchema as mentionLookupResponseSchema,
  mentionImportUndoResponseSchema as mentionUndoResponseSchema,
  type MentionImportItem,
} from '@oxy.so/mention-contracts';
import { MENTION_IMPORT_BATCH_MAX_ITEMS as MENTION_BATCH_MAX_ITEMS } from '@oxy.so/mention-contracts';
const MENTION_BATCH_TARGET_BYTES = 900_000;

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
