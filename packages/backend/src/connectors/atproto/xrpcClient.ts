// Provenance: `buildXrpcUrl`, the DID-document readers and the hosts are copied
// from OxyHQ/Mention packages/backend/src/connectors/atproto/xrpcClient.ts,
// identityResolver.ts and constants.ts @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b
// (origin/main). Trimmed to what a reader of a KNOWN DID needs: Move's linked
// account is always a DID, so handle resolution stays in Mention.

import { publicGet } from '../../utils/safeUpstreamFetch';

/** Bluesky's public AppView: every read XRPC query, no token. */
export const PUBLIC_APPVIEW = 'public.api.bsky.app';

const PLC_DIRECTORY = 'plc.directory';
const DID_PLC_RE = /^did:plc:[a-z2-7]{24}$/;
const DID_DOCUMENT_MAX_BYTES = 256 * 1024;
const DID_DOCUMENT_TIMEOUT_MS = 8_000;

/** `https://{host}/xrpc/{nsid}?{params}`, skipping undefined params. */
export function buildXrpcUrl(
  host: string,
  nsid: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return `https://${host}/xrpc/${nsid}${qs ? `?${qs}` : ''}`;
}

/** Where a `did:plc:` (PLC directory) or `did:web:` (its `did.json`) document lives. */
function didDocumentUrl(did: string): string | undefined {
  if (DID_PLC_RE.test(did)) return `https://${PLC_DIRECTORY}/${did}`;
  if (!did.startsWith('did:web:')) return undefined;
  const [host, ...path] = did
    .slice('did:web:'.length)
    .split(':')
    .map((segment) => decodeURIComponent(segment));
  if (!host) return undefined;
  return path.length > 0
    ? `https://${host}/${path.join('/')}/did.json`
    : `https://${host}/.well-known/did.json`;
}

/**
 * The account's PDS endpoint (`#atproto_pds` in its DID document), where the
 * ORIGINAL blobs and the public block records live. Throws when unreachable.
 */
export async function resolvePdsEndpoint(did: string): Promise<string | undefined> {
  const url = didDocumentUrl(did);
  if (!url) return undefined;
  const { status, body } = await publicGet(url, {
    accept: 'application/json',
    maxBytes: DID_DOCUMENT_MAX_BYTES,
    timeoutMs: DID_DOCUMENT_TIMEOUT_MS,
  });
  if (!body) throw new Error(`DID document answered ${status}`);
  const document = JSON.parse(body.toString('utf8')) as {
    service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }>;
  };
  const service = document.service?.find(
    (entry) => entry.id === '#atproto_pds' || entry.type === 'AtprotoPersonalDataServer',
  );
  return typeof service?.serviceEndpoint === 'string' ? service.serviceEndpoint : undefined;
}
