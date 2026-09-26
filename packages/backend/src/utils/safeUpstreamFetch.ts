// Provenance: `buildRequestOptions`, `fetchOnce` and the per-hop validation are
// copied from OxyHQ/Mention packages/backend/src/utils/safeUpstreamFetch.ts and
// connectors/shared/httpBody.ts @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b
// (origin/main). Trimmed to the one bounded GET Move needs; the media-proxy
// extras and POST are Mention's. CHANGED: `signHeaders` re-signs each hop, for
// the reads Oxy's instance actor signs (`sources/http.ts`).

import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { assertSafePublicUrl, SsrfRejection, UpstreamError } from '@oxy.so/core/server';

/**
 * The ONE way Move reads a URL a remote chose. Every hop — the first and each
 * redirect — is validated by `assertSafePublicUrl` (DNS + private/reserved-range
 * denylist) and the TCP connection is PINNED to the validated IP, closing the
 * DNS-rebind window. The body is read under a hard byte cap.
 */

const USER_AGENT = 'OxyMove/1.0 (+https://move.oxy.so)';

const MAX_REDIRECTS = 3;
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The body was larger than the caller's cap (declared or streamed). */
export class ResponseTooLargeError extends Error {
  constructor() {
    super('remote response exceeds the size limit');
    this.name = 'ResponseTooLargeError';
  }
}

export interface PublicGetOptions {
  accept: string;
  maxBytes: number;
  /** Deadline for the whole request, body included. */
  timeoutMs: number;
  /** Deadline for the response headers (time to first byte). Defaults to `timeoutMs`. */
  headersTimeoutMs?: number;
  headers?: Record<string, string>;
  /**
   * Headers to add to ONE hop, computed for that hop's URL — an HTTP signature
   * is bound to the `(request-target)` and `host` of exactly one URL, so every
   * redirect needs a fresh one. Called after the hop passed the SSRF guard.
   */
  signHeaders?: (url: string) => Promise<Record<string, string>>;
}

export interface PublicGetResult {
  status: number;
  headers: IncomingHttpHeaders;
  /** The body of a 2xx; undefined otherwise. */
  body?: Buffer;
}

function buildRequestOptions(
  target: URL,
  pinnedIp: string,
  pinnedFamily: 4 | 6,
  headers: Record<string, string>,
  signal: AbortSignal,
): https.RequestOptions {
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers,
    signal,
    // Pin the connection to the validated IP — DNS is NOT re-resolved here.
    // Bun may call a custom lookup with `{ all: true }` and sort the result, so
    // that form MUST get an array back.
    lookup: ((
      _hostname: string,
      options: number | LookupOneOptions | LookupAllOptions,
      callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
    ): void => {
      if (typeof options === 'object' && options !== null && options.all === true) {
        callback(null, [{ address: pinnedIp, family: pinnedFamily }]);
      } else {
        callback(null, pinnedIp, pinnedFamily);
      }
    }) as unknown as LookupFunction,
  };
}

function fetchOnce(options: https.RequestOptions, isHttps: boolean, headersTimeoutMs: number): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = (isHttps ? https : http).request(options, resolve);
    req.setTimeout(headersTimeoutMs, () => req.destroy(new Error('upstream headers timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function readBounded(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) throw new ResponseTooLargeError();
      chunks.push(buffer);
    }
  } finally {
    if (!response.destroyed) response.destroy();
  }
  return Buffer.concat(chunks, total);
}

/**
 * GET `url`, following up to three redirects (each re-validated), and read a
 * 2xx body under `maxBytes`. Non-2xx answers are RETURNED with their headers so
 * the caller can read `Retry-After`.
 *
 * @throws {SsrfRejection} a hop targets a blocked address.
 * @throws {ResponseTooLargeError} the body exceeds `maxBytes`.
 */
export async function publicGet(url: string, options: PublicGetOptions): Promise<PublicGetResult> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const headers = { 'User-Agent': USER_AGENT, Accept: options.accept, ...options.headers };
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await assertSafePublicUrl(current);
    if (!guard.ok) throw new SsrfRejection(guard.reason);
    const target = new URL(current);
    const hopHeaders = options.signHeaders ? { ...headers, ...(await options.signHeaders(current)) } : headers;
    const response = await fetchOnce(
      buildRequestOptions(target, guard.ip, guard.family, hopHeaders, signal),
      target.protocol === 'https:',
      options.headersTimeoutMs ?? options.timeoutMs,
    );
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (REDIRECT_STATUS_CODES.has(status) && typeof location === 'string') {
      // Never drain a redirect body: it could be unbounded.
      response.destroy();
      current = new URL(location, current).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      return { status, headers: response.headers };
    }
    if (Number(response.headers['content-length']) > options.maxBytes) {
      response.destroy();
      throw new ResponseTooLargeError();
    }
    return { status, headers: response.headers, body: await readBounded(response, options.maxBytes) };
  }
  throw new UpstreamError('too many redirects');
}
