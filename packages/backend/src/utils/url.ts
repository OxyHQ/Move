// Provenance: copied from OxyHQ/Mention packages/backend/src/connectors/shared/url.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). Trimmed to what Move uses.

/** True when `value` is an absolute `http(s)` URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
