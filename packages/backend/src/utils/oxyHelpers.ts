// Provenance: `getServiceOxyClient` and `uploadServiceUserMedia` copied from
// OxyHQ/Mention packages/backend/src/utils/oxyHelpers.ts @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b
// (origin/main). Trimmed: the per-request scoped clients, the MCP delegation, the
// privacy-graph client, the egress metrics and the profile-media promotion are
// Mention product code and stay there. CHANGED: the upload error carries the
// HTTP status and `Retry-After`, because Move's media limiter must tell a 429
// (pause the job) from any other failure.

import { OxyServices } from '@oxy.so/core';
import { canAttestWorkloadIdentity } from '@oxy.so/core/server';
import { config } from '../config';
import { logger } from './logger';

/**
 * The OxyServices instance authenticated as Oxy Move. In ECS there is no key
 * pair: the SDK attests the task role (`oxy-move-task`, oxy ADR 0026). Locally
 * an `OXY_SERVICE_API_KEY`/`SECRET` pair is honoured when present.
 */
let serviceClient: OxyServices | null = null;

export function getServiceOxyClient(): OxyServices {
  if (serviceClient) return serviceClient;
  const client = new OxyServices({ baseURL: config.oxyApiUrl });
  const { apiKey, apiSecret } = config.oxyServiceCredentials;
  if (apiKey && apiSecret) {
    client.configureServiceAuth(apiKey, apiSecret);
  } else if (canAttestWorkloadIdentity()) {
    logger.info('[oxyHelpers] no service key pair; the Oxy client attests this task role instead');
  } else {
    logger.warn(
      '[oxyHelpers] no Oxy service identity: neither a key pair nor an attestable task role. Calls needing one will fail.',
    );
  }
  serviceClient = client;
  return client;
}


/** A failed upload, with what the caller needs to decide between retry and pause. */
export class OxyUploadError extends Error {
  readonly status: number;
  readonly retryAfter?: string;
  constructor(message: string, status: number, retryAfter?: string) {
    super(message);
    this.name = 'OxyUploadError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Upload media bytes to Oxy as a durable public asset owned by `ownerUserId`,
 * using Move's service credential.
 */
export async function uploadServiceUserMedia(params: {
  ownerUserId: string;
  buffer: Buffer;
  contentType: string;
  fileName: string;
}): Promise<{ fileId: string }> {
  const client = getServiceOxyClient();
  const token = await client.getServiceToken();
  const baseUrl = client.getBaseURL().replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/assets/service/user-media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': params.contentType,
      'Content-Length': String(params.buffer.length),
      'x-owner-user-id': params.ownerUserId,
      'x-original-name': encodeURIComponent(params.fileName),
      Accept: 'application/json',
    },
    body: params.buffer,
  });

  const rawText = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const errBody = JSON.parse(rawText) as { message?: string; error?: string };
      detail = errBody.message || errBody.error || '';
    } catch {
      detail = rawText;
    }
    throw new OxyUploadError(
      detail || `Oxy user-media upload failed (${response.status})`,
      response.status,
      response.headers.get('retry-after') ?? undefined,
    );
  }

  const body = JSON.parse(rawText) as { data?: { file?: { id?: string } } };
  const fileId = body.data?.file?.id;
  if (typeof fileId !== 'string' || fileId.length === 0) {
    throw new Error('Oxy user-media upload response missing file id');
  }

  return { fileId };
}
