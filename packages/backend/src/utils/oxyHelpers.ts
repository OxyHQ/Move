// Provenance: `getServiceOxyClient` copied from
// OxyHQ/Mention packages/backend/src/utils/oxyHelpers.ts @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b
// (origin/main). Trimmed: the per-request scoped clients, the MCP delegation, the
// privacy-graph client, the egress metrics and the profile-media promotion are
// Mention product code and stay there. REMOVED: `uploadServiceUserMedia`, the
// hand-rolled `POST /assets/service/user-media` upload copied with it — Move
// now has Oxy import media by URL (`destinations/media.ts`, ADR 0043 D7).

import { OxyServer, canAttestWorkloadIdentity } from '@oxy.so/core/server';
import { config } from '../config';
import { logger } from './logger';

/**
 * The OxyServer instance authenticated as Oxy Move. In ECS there is no key
 * pair: the SDK attests the task role (`oxy-move-task`, oxy ADR 0026). Locally
 * an `OXY_SERVICE_API_KEY`/`SECRET` pair is honoured when present.
 */
let serviceClient: OxyServer | null = null;

export function getServiceOxyClient(): OxyServer {
  if (serviceClient) return serviceClient;
  const { apiKey, apiSecret } = config.oxyServiceCredentials;
  const serviceAuth = apiKey && apiSecret ? { apiKey, apiSecret } : undefined;
  if (!serviceAuth) {
    if (canAttestWorkloadIdentity()) {
      logger.info(
        '[oxyHelpers] no service key pair; the Oxy client attests this task role instead',
      );
    } else {
      logger.warn(
        '[oxyHelpers] no Oxy service identity: neither a key pair nor an attestable task role. Calls needing one will fail.',
      );
    }
  }
  const client = new OxyServer({ baseURL: config.oxyApiUrl, serviceAuth });
  serviceClient = client;
  return client;
}
