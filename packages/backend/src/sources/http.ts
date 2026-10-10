/**
 * How sources talk to the outside world: one SSRF-safe JSON GET
 * ({@link publicGet}: IP-pinned, every redirect re-validated, byte-capped) and
 * one per-platform backoff policy around it. Sources take a {@link JsonFetcher}
 * rather than calling this directly, so the mapping tests replay recorded
 * responses without a network.
 */

import { SsrfRejection } from '@oxy.so/core/server';
import { ResponseTooLargeError, publicGet } from '../utils/safeUpstreamFetch';

/** Largest JSON document a source will buffer (2 MiB, as Mention's AP reads). */
const SOURCE_JSON_MAX_BYTES = 2 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 15_000;

export interface JsonResponse {
  status: number;
  /** Lowercased header names. */
  headers: Record<string, string | undefined>;
  /** Parsed JSON for a 2xx; undefined otherwise. */
  body: unknown;
}

export interface JsonRequest {
  accept: string;
  /**
   * Send the GET with an HTTP signature from Oxy's instance actor. Only a
   * fetcher built with a {@link RequestSigner} can; the others refuse with
   * {@link SourceAuthRequiredError}, which is what an unsigned 401 means.
   */
  signed?: boolean;
}

/**
 * Headers that sign ONE GET of `url` (`Host`, `Date`, `Signature`). In
 * production this is Oxy's `POST /federation/instance-fetch/sign`: the instance
 * actor signs, Move holds no key.
 */
export type RequestSigner = (url: string) => Promise<Record<string, string>>;

export type JsonFetcher = (url: string, request: JsonRequest) => Promise<JsonResponse>;

/** A remote asked us to slow down for longer than we are willing to wait inline. */
export class SourceRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'SourceRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** The account or collection is gone (404/410) — permanent for this job. */
export class SourceUnavailableError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SourceUnavailableError';
    this.status = status;
  }
}

/**
 * The remote refused the read (401/403) even when Oxy's instance actor signed
 * it — the server blocks oxy.so, or federates only with an allow-list — or
 * Move had no signer to try. Mastodon answers every unsigned read 401 when the
 * instance runs in authorized-fetch ("secure") mode; that alone is retried
 * signed and does not end here.
 */
export class SourceAuthRequiredError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SourceAuthRequiredError';
    this.status = status;
  }
}

/** Any other non-2xx after retries. */
export class SourceHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SourceHttpError';
    this.status = status;
  }
}

/**
 * The production {@link JsonFetcher}. Non-2xx responses are RETURNED, not
 * thrown, so the backoff layer can read their status and `Retry-After`. A
 * `signed` request is signed per hop by `signer`; without one it is refused.
 */
export function createPublicJsonFetcher(signer?: RequestSigner): JsonFetcher {
  return async (url, request) => {
    if (request.signed && !signer) {
      throw new SourceAuthRequiredError(
        'the source needs a signed read and no signer is configured',
        401,
      );
    }
    return fetchJsonOnce(url, request, request.signed ? signer : undefined);
  };
}

/** Unsigned reads only (Bluesky's public XRPC never needs a signature). */
export const fetchPublicJson: JsonFetcher = createPublicJsonFetcher();

async function fetchJsonOnce(
  url: string,
  request: JsonRequest,
  signer: RequestSigner | undefined,
): Promise<JsonResponse> {
  const { status, headers, body } = await publicGet(url, {
    accept: request.accept,
    maxBytes: SOURCE_JSON_MAX_BYTES,
    timeoutMs: SOURCE_TIMEOUT_MS,
    ...(signer ? { signHeaders: signer } : {}),
  });
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers))
    flat[key] = Array.isArray(value) ? value.join(', ') : value;
  if (!body) return { status, headers: flat, body: undefined };
  try {
    return { status, headers: flat, body: JSON.parse(body.toString('utf8')) };
  } catch {
    throw new SourceHttpError('remote returned invalid JSON', status);
  }
}

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds from now. */
export function parseRetryAfterMs(
  value: string | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export interface BackoffPolicy {
  /** Minimum gap between two requests to the same host (politeness). */
  minIntervalMs: number;
  /** Attempts per request, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * The longest wait honoured INLINE. A remote asking for more than this pauses
   * the job (it is re-scheduled, never failed) instead of holding a worker.
   */
  maxInlineWaitMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  minIntervalMs: 250,
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxInlineWaitMs: 60_000,
};

/** Per-platform politeness, tuned to each platform's published limits. */
export const PLATFORM_BACKOFF = {
  // Mastodon's default is 300 requests / 5 min per IP for unauthenticated reads.
  mastodon: { ...DEFAULT_BACKOFF, minIntervalMs: 1_000 },
  // Bluesky's public AppView allows 3000 / 5 min per IP.
  bluesky: { ...DEFAULT_BACKOFF, minIntervalMs: 150 },
} as const satisfies Record<string, BackoffPolicy>;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a {@link JsonFetcher} in a platform's backoff: a per-host minimum
 * interval, retries with exponential backoff on 429/5xx and transport errors,
 * `Retry-After` honoured, and a {@link SourceRateLimitedError} when the remote
 * asks for longer than {@link BackoffPolicy.maxInlineWaitMs}. 404/410 (and a
 * non-public address) become {@link SourceUnavailableError}; other non-2xx are
 * RETURNED for the caller.
 */
export function withBackoff(
  fetcher: JsonFetcher,
  policy: BackoffPolicy,
  sleep: Sleep = realSleep,
  now: () => number = Date.now,
): JsonFetcher {
  const lastRequestAt = new Map<string, number>();

  return async (url, request) => {
    const host = new URL(url).host;
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const previous = lastRequestAt.get(host);
      if (previous !== undefined) {
        const gap = previous + policy.minIntervalMs - now();
        if (gap > 0) await sleep(gap);
      }
      lastRequestAt.set(host, now());

      let response: JsonResponse;
      try {
        response = await fetcher(url, request);
      } catch (error) {
        // Permanent: retrying cannot change the answer.
        if (error instanceof SourceHttpError || error instanceof SourceAuthRequiredError)
          throw error;
        // Oxy's signing budget, not the remote's: pause, never hammer.
        if (error instanceof SourceRateLimitedError) throw error;
        if (error instanceof SsrfRejection)
          throw new SourceUnavailableError('source address is not public', 0);
        if (error instanceof ResponseTooLargeError) throw new SourceHttpError(error.message, 200);
        lastError = error;
        if (attempt === policy.maxAttempts) break;
        await sleep(Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)));
        continue;
      }

      if (response.status === 404 || response.status === 410) {
        throw new SourceUnavailableError(`source answered ${response.status}`, response.status);
      }
      if (!RETRYABLE_STATUSES.has(response.status)) return response;

      const retryAfter = parseRetryAfterMs(response.headers['retry-after'], now());
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const wait = retryAfter ?? backoff;
      if (
        response.status === 429 &&
        (wait > policy.maxInlineWaitMs || attempt === policy.maxAttempts)
      ) {
        throw new SourceRateLimitedError(
          `source rate limited (${host})`,
          Math.max(wait, policy.baseDelayMs),
        );
      }
      if (attempt === policy.maxAttempts) {
        throw new SourceHttpError(
          `source answered ${response.status} after ${attempt} attempts`,
          response.status,
        );
      }
      await sleep(Math.min(wait, policy.maxInlineWaitMs));
    }
    throw lastError instanceof Error ? lastError : new Error('source request failed');
  };
}
