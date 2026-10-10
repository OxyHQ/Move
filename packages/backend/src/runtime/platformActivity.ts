// Provenance: copied from OxyHQ/Mention packages/backend/src/runtime/platformActivity.ts
// @ origin/main (2026-10-10). Same workload-identity gate; the default service
// name is Move's ECS service name, which is what the dashboard registry shows.

import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';

export type PlatformActivity = ReturnType<typeof createEcosystemTraffic>;

/**
 * Publish this process's traffic and its infrastructure heartbeat to Oxy's
 * shared ecosystem telemetry (`/platform-activity` and the oxy.so dashboard).
 *
 * There is no `OXY_ECOSYSTEM_ACTIVITY_ENABLED`. "Am I a deployed process" is a
 * fact about where the code runs: ECS sets the container credentials endpoint
 * on every task and nothing else does, which is the same signal the
 * credential-free service token uses to prove what this process IS (oxy ADR
 * 0026). On the infrastructure it publishes; in a local checkout or a test it
 * returns `undefined` and nothing is started.
 */
export function startPlatformActivity(ready: () => boolean, service = 'move'): PlatformActivity | undefined {
  if (!canAttestWorkloadIdentity()) return undefined;
  const traffic = createEcosystemTraffic({ service, ready });
  traffic.installFetch();
  return traffic;
}
