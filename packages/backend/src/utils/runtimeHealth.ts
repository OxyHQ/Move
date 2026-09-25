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
