// Provenance: copied from OxyHQ/Mention packages/backend/src/utils/ingestTimestamp.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). Unchanged code.

/**
 * An externally asserted ISO 8601 creation date, or undefined when it is
 * missing, unparseable, or more than `maxFutureSkewMs` in the future. REJECT,
 * never clamp: a post re-dated to the window edge would still sort above
 * everything else.
 */
export function clampFutureDate(value: unknown, maxFutureSkewMs: number): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return undefined;

  if (ms > Date.now() + maxFutureSkewMs) return undefined;

  return parsed;
}
