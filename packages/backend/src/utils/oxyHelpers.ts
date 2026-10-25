// Provenance: `getServiceOxyClient` copied from
// OxyHQ/Mention packages/backend/src/utils/oxyHelpers.ts @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b
// (origin/main). Trimmed: the per-request scoped clients, the MCP delegation, the
// privacy-graph client, the egress metrics and the profile-media promotion are
// Mention product code and stay there. REMOVED: `uploadServiceUserMedia`, the
// hand-rolled `POST /assets/service/user-media` upload copied with it — Move
// now has Oxy import media by URL (`destinations/media.ts`, ADR 0043 D7).

import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { config } from '../config';

let serviceClient: OxyServer | null = null;
/** The shared infrastructure provider supports task roles and temporary local SSO roles. */
export function getServiceOxyClient(): OxyServer {
  serviceClient ??= new OxyServer({
    baseURL: config.oxyApiUrl,
    workloadCredentials: createAwsWorkloadCredentialProvider(),
  });
  return serviceClient;
}
