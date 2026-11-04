// The redirect loop is Move's own: `signHeaders` re-signs each hop, for the
// reads Oxy's instance actor signs (`sources/http.ts`). Validation, IP pinning
// and the bounded body read are the SDK's `safeFetch` and `readResponseBody`.

import type { IncomingHttpHeaders } from 'node:http';
import { readResponseBody, safeFetch, UpstreamError } from '@oxy.so/core/server';

/**
 * The ONE way Move reads a URL a remote chose. Every hop — the first and each
 * redirect — is its own `safeFetch` (`redirect: 'manual'`): the URL is checked
 * by `assertSafePublicUrl` (DNS + private/reserved-range denylist) and the TCP
 * connection is PINNED to the validated IP, closing the DNS-rebind window. The
 * body is read under a hard byte cap and the request's one deadline.
 *
 * The SDK follows redirects itself only with the SAME headers on every hop, and
 * an HTTP signature is bound to one URL, so a signed read follows them here.
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
   * redirect needs a fresh one. A hop that then fails the SSRF guard is never
   * sent, so a signature for it goes nowhere.
   */
  signHeaders?: (url: string) => Promise<Record<string, string>>;
}

export interface PublicGetResult {
  status: number;
  headers: IncomingHttpHeaders;
  /** The body of a 2xx; undefined otherwise. */
  body?: Buffer;
}

/**
 * GET `url`, following up to three redirects (each re-validated), and read a
 * 2xx body under `maxBytes`. Non-2xx answers are RETURNED with their headers so
 * the caller can read `Retry-After`.
 *
 * @throws {SsrfRejection} a hop targets a blocked address.
 * @throws {ResponseTooLargeError} the body exceeds `maxBytes`.
 * @throws {UpstreamError} too many redirects, a timeout, or a failed transport.
 */
export async function publicGet(url: string, options: PublicGetOptions): Promise<PublicGetResult> {
  const deadline = Date.now() + options.timeoutMs;
  const signal = AbortSignal.timeout(options.timeoutMs);
  const headers = { 'User-Agent': USER_AGENT, Accept: options.accept, ...options.headers };
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const hopHeaders = options.signHeaders
      ? { ...headers, ...(await options.signHeaders(current)) }
      : headers;
    const {
      response,
      status,
      headers: responseHeaders,
    } = await safeFetch(current, {
      headers: hopHeaders,
      redirect: 'manual',
      headersTimeoutMs: options.headersTimeoutMs ?? options.timeoutMs,
      signal,
    });
    const location = responseHeaders.location;
    if (REDIRECT_STATUS_CODES.has(status) && typeof location === 'string') {
      // Never drain a redirect body: it could be unbounded.
      response.destroy();
      current = new URL(location, current).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      return { status, headers: responseHeaders };
    }
    if (Number(responseHeaders['content-length']) > options.maxBytes) {
      response.destroy();
      throw new ResponseTooLargeError();
    }
    const read = await readResponseBody(response, {
      maxBytes: options.maxBytes,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    switch (read.kind) {
      case 'ok':
        return { status, headers: responseHeaders, body: read.body };
      case 'too_large':
        throw new ResponseTooLargeError();
      case 'timeout':
        throw new UpstreamError('upstream body timeout');
      case 'error':
        throw read.error;
    }
  }
  throw new UpstreamError('too many redirects');
}
