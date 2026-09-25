/**
 * Copying a source's media into the user's Oxy files, behind ONE limiter.
 *
 * Oxy allows about 30 `/assets/service/user-media` uploads per minute PER
 * APPLICATION, shared by every Move task and job, so the limiter is a Redis
 * fixed window keyed by minute. Without Redis (or while it is down) it falls
 * back to a per-process window — exact at one task, the production shape today.
 *
 * Exhausting the budget never fails a job: a wait of up to 5 s is taken inline,
 * anything longer (and any 429 from Oxy) raises {@link MediaRateLimitedError},
 * which pauses the job. Oxy's 429 also blocks the whole fleet's window until its
 * `Retry-After`.
 */

import { config } from '../config';
import { ResponseTooLargeError, publicGet } from '../utils/safeUpstreamFetch';
import { getReadyRedis } from '../utils/redis';
import { logger } from '../utils/logger';
import { OxyUploadError, uploadServiceUserMedia } from '../utils/oxyHelpers';
import { parseRetryAfterMs, realSleep, type Sleep } from '../sources/http';
import type { SourceMedia } from '../sources/types';

export class MediaRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'MediaRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

type AcquireResult = { ok: true } | { ok: false; retryAfterMs: number };

export interface UploadLimiter {
  acquire(): Promise<AcquireResult>;
  /** Oxy said 429: block every acquirer until `retryAfterMs` from now. */
  block(retryAfterMs: number): Promise<void>;
}

const WINDOW_MS = 60_000;
/** Inline waits up to this long; longer pauses the job. */
const MAX_INLINE_WAIT_MS = 5_000;
const MEDIA_TIMEOUT_MS = 120_000;
const MEDIA_HEADERS_TIMEOUT_MS = 15_000;
const UPLOADABLE = /^(image|video)\//;

/** Per-process window: the fallback, and the test double. */
export function createMemoryUploadLimiter(limit: number, now: () => number = Date.now): UploadLimiter {
  let windowStart = 0;
  let used = 0;
  let blockedUntil = 0;
  return {
    async acquire() {
      const at = now();
      if (at < blockedUntil) return { ok: false, retryAfterMs: blockedUntil - at };
      const window = Math.floor(at / WINDOW_MS) * WINDOW_MS;
      if (window !== windowStart) {
        windowStart = window;
        used = 0;
      }
      if (used >= limit) return { ok: false, retryAfterMs: windowStart + WINDOW_MS - at };
      used++;
      return { ok: true };
    },
    async block(retryAfterMs) {
      blockedUntil = Math.max(blockedUntil, now() + retryAfterMs);
    },
  };
}

const ACQUIRE_SCRIPT = `
local blocked = redis.call('PTTL', KEYS[2])
if blocked > 0 then return {0, blocked} end
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then return {0, redis.call('PTTL', KEYS[1])} end
return {1, 0}`;

const BLOCK_KEY = 'move:media-uploads:blocked';

/** The fleet-wide limiter, falling back to a per-process window whenever Redis is not ready. */
export function createUploadLimiter(limit: number): UploadLimiter {
  const local = createMemoryUploadLimiter(limit);
  return {
    async acquire() {
      const redis = getReadyRedis();
      if (!redis) return local.acquire();
      try {
        const windowKey = `move:media-uploads:${Math.floor(Date.now() / WINDOW_MS)}`;
        const [ok, wait] = (await redis.eval(ACQUIRE_SCRIPT, 2, windowKey, BLOCK_KEY, limit, WINDOW_MS + 5_000)) as [number, number];
        return ok === 1 ? { ok: true } : { ok: false, retryAfterMs: Math.max(1_000, wait) };
      } catch (error) {
        logger.debug('[media] Redis limiter unavailable, using the local window', error);
        return local.acquire();
      }
    },
    async block(retryAfterMs) {
      await local.block(retryAfterMs);
      await getReadyRedis()?.set(BLOCK_KEY, '1', 'PX', Math.max(1_000, Math.round(retryAfterMs))).catch(() => undefined);
    },
  };
}

interface DownloadedMedia {
  buffer: Buffer;
  contentType: string;
}

type MediaDownloader = (url: string, maxBytes: number) => Promise<DownloadedMedia | null>;

/** SSRF-safe, byte-capped download; null when the file can never be copied (gone, too large). */
async function downloadMedia(url: string, maxBytes: number): Promise<DownloadedMedia | null> {
  try {
    const { status, headers, body } = await publicGet(url, {
      accept: '*/*',
      headers: { 'Accept-Encoding': 'identity' },
      maxBytes,
      timeoutMs: MEDIA_TIMEOUT_MS,
      headersTimeoutMs: MEDIA_HEADERS_TIMEOUT_MS,
    });
    if (status === 404 || status === 410) return null;
    if (!body) throw new Error(`media download answered ${status}`);
    const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'].split(';')[0].trim().toLowerCase() : '';
    return { buffer: body, contentType };
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return null;
    throw error;
  }
}

function fileNameOf(url: string): string {
  const last = new URL(url).pathname.split('/').pop() || 'media';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export interface MediaCopier {
  /** Copy each entry; entries that can never be copied are dropped. */
  copy(ownerUserId: string, media: SourceMedia[]): Promise<Array<SourceMedia & { assetId: string }>>;
}

export function createMediaCopier(deps: {
  limiter: UploadLimiter;
  download?: MediaDownloader;
  upload?: typeof uploadServiceUserMedia;
  sleep?: Sleep;
}): MediaCopier {
  const download = deps.download ?? downloadMedia;
  const upload = deps.upload ?? uploadServiceUserMedia;
  const sleep = deps.sleep ?? realSleep;

  const acquire = async (): Promise<void> => {
    for (;;) {
      const result = await deps.limiter.acquire();
      if (result.ok) return;
      if (result.retryAfterMs > MAX_INLINE_WAIT_MS) {
        throw new MediaRateLimitedError('media upload budget exhausted', result.retryAfterMs);
      }
      await sleep(result.retryAfterMs);
    }
  };

  return {
    async copy(ownerUserId, media) {
      const copied: Array<SourceMedia & { assetId: string }> = [];
      for (const entry of media) {
        if (!UPLOADABLE.test(entry.mimeType)) continue;
        // The budget first: a pause must not throw away a finished download.
        await acquire();
        const file = await download(entry.url, config.media.maxBytes);
        if (!file) continue;
        const contentType = UPLOADABLE.test(file.contentType) ? file.contentType : entry.mimeType;
        try {
          const result = await upload({ ownerUserId, buffer: file.buffer, contentType, fileName: fileNameOf(entry.url) });
          copied.push({ ...entry, mimeType: contentType, assetId: result.fileId });
        } catch (error) {
          if (error instanceof OxyUploadError && error.status === 429) {
            const retryAfterMs = parseRetryAfterMs(error.retryAfter) ?? WINDOW_MS;
            await deps.limiter.block(retryAfterMs);
            throw new MediaRateLimitedError('Oxy is rate limiting media uploads', retryAfterMs);
          }
          if (error instanceof OxyUploadError && (error.status === 413 || error.status === 415)) {
            logger.info('[media] Oxy refused a media file permanently', { status: error.status });
            continue;
          }
          throw error;
        }
      }
      return copied;
    },
  };
}
