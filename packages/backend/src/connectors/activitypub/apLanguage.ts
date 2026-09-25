// Provenance: copied from OxyHQ/Mention packages/backend/src/connectors/activitypub/apLanguage.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). Trimmed to the
// single-language reader Move uses.

/** A BCP-47 tag's ISO 639-1 primary subtag (`pt-BR` → `pt`), or undefined. */
function toIso6391(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  const primary = tag.trim().toLowerCase().split('-')[0];
  return /^[a-z]{2}$/.test(primary) ? primary : undefined;
}

/** An AP object's `contentMap` (BCP-47 tag → localized HTML), when it is a plain record. */
export function getApContentMap(object: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  const contentMap = object?.contentMap;
  return contentMap && typeof contentMap === 'object' && !Array.isArray(contentMap)
    ? (contentMap as Record<string, unknown>)
    : undefined;
}

/**
 * The post's language: the top-level `language`, else the single key of an
 * unambiguous one-entry `contentMap`.
 */
export function extractApLanguage(object: Record<string, unknown> | null | undefined): string | undefined {
  if (!object) return undefined;
  const fromLanguage = toIso6391(object.language);
  if (fromLanguage) return fromLanguage;
  const keys = Object.keys(getApContentMap(object) ?? {});
  return keys.length === 1 ? toIso6391(keys[0]) : undefined;
}
