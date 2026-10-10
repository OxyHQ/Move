// Provenance: trimmed from OxyHQ/Mention packages/backend/src/utils/runtimeHealth.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). Move's readiness reads
// the migration ledger on every probe, so only the lifecycle phase is kept here.

export type RuntimePhase = 'starting' | 'ready' | 'shutting_down';

let phase: RuntimePhase = 'starting';

export function markRuntimeReady(): void {
  phase = 'ready';
}

export function markRuntimeShuttingDown(): void {
  phase = 'shutting_down';
}

export function getRuntimePhase(): RuntimePhase {
  return phase;
}

/**
 * The last verdict `/ready` returned, for consumers that need readiness
 * synchronously (the platform-activity heartbeat). `/ready` itself reads
 * Postgres and the migration ledger on every probe, which a sync callback
 * cannot, so the ALB's own probes keep this current; until the first probe
 * the answer is "not ready", never a guess.
 */
let lastReadinessVerdict = false;

export function recordReadinessVerdict(ready: boolean): void {
  lastReadinessVerdict = ready;
}

/** Ready for traffic: not draining AND the last `/ready` probe passed. */
export function isRuntimeReady(): boolean {
  return phase === 'ready' && lastReadinessVerdict;
}
