/**
 * How a failure maps onto a job's fate. One table, so the runner, the worker's
 * exhausted-retries handler and the API agree on what each error MEANS.
 *
 * - PAUSE: somebody asked us to slow down (a source 429, Oxy's media budget,
 *   Mention's 429). The job is `paused` and re-enqueued for `retryAfterMs`
 *   later. Never a failure: a large migration is EXPECTED to hit these.
 * - FAIL: permanent for this job, with a stable code the client can explain.
 * - RETRY: anything else is transient; the BullMQ attempt fails and is retried
 *   with backoff, resuming from the last checkpoint.
 */

import { ForeignLinkedAccountError } from '../destinations/oxy';
import { DestinationRateLimitedError, DestinationRejectedError } from '../destinations/types';
import { MediaRateLimitedError } from '../destinations/media';
import {
  SourceAuthRequiredError,
  SourceRateLimitedError,
  SourceUnavailableError,
} from '../sources/http';

/** The job was cancelled or undone while the worker held it. */
export class JobCancelledError extends Error {
  constructor() {
    super('job cancelled');
    this.name = 'JobCancelledError';
  }
}

export type JobFailureCode =
  | 'linked-account-not-owned'
  | 'linked-account-changed'
  | 'source-requires-authorized-fetch'
  | 'source-unavailable'
  | 'destination-rejected'
  | 'retries-exhausted';

export type Disposition =
  | { kind: 'pause'; retryAfterMs: number }
  | { kind: 'fail'; code: JobFailureCode; detail?: string }
  | { kind: 'cancelled' }
  | { kind: 'retry' };

/** Floor and ceiling on a pause, so a bogus `Retry-After` cannot park a job for a week. */
const MIN_PAUSE_MS = 5_000;
const MAX_PAUSE_MS = 6 * 60 * 60 * 1000;

export function classify(error: unknown): Disposition {
  if (error instanceof JobCancelledError) return { kind: 'cancelled' };
  if (
    error instanceof SourceRateLimitedError
    || error instanceof MediaRateLimitedError
    || error instanceof DestinationRateLimitedError
  ) {
    return { kind: 'pause', retryAfterMs: Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, error.retryAfterMs)) };
  }
  // Oxy's own 429 on the service calls (identities, linked accounts) arrives as
  // the SDK's plain ApiError object with `status`.
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 429) return { kind: 'pause', retryAfterMs: 60_000 };
  if (error instanceof ForeignLinkedAccountError) return { kind: 'fail', code: 'linked-account-not-owned' };
  if (error instanceof SourceAuthRequiredError) return { kind: 'fail', code: 'source-requires-authorized-fetch' };
  if (error instanceof SourceUnavailableError) return { kind: 'fail', code: 'source-unavailable', detail: String(error.status) };
  if (error instanceof DestinationRejectedError) {
    return { kind: 'fail', code: 'destination-rejected', detail: error.message.slice(0, 300) };
  }
  return { kind: 'retry' };
}
