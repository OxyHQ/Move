/**
 * Importing a source's media into the user's Oxy files, behind ONE limiter.
 *
 * Move never downloads a media file: it hands the source URL to Oxy
 * (`OxyServer.assets.importUserMedia`, `POST /assets/service/user-media/import`,
 * ADR 0043 D7), which fetches it with its own SSRF-safe fetcher and stores it as
 * a file OWNED BY the user. Oxy remembers each (user, URL) it imported, so a
 * second migration of the same account answers the existing file without a
 * download.
 *
 * Move registers no reference to the files (`docs/oxy-files.md`): Mention uses
 * them in the posts it creates, and the user's profile uses the avatar.
 *
 * Oxy allows about 30 media imports and uploads per minute PER APPLICATION,
 * shared by every Move task and job, so the limiter is a Redis fixed window
 * keyed by minute. Without Redis (or while it is down) it falls back to a
 * per-process window — exact at one task, the production shape today.
 *
 * Exhausting the budget never fails a job: a wait of up to 5 s is taken inline,
 * anything longer (and any 429 from Oxy) raises {@link MediaRateLimitedError},
 * which pauses the job. Oxy's 429 also blocks the whole fleet's window until
 * the time it names.
 */

import { getReadyRedis } from '../utils/redis';
import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { realSleep, type Sleep } from '../sources/http';
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
const UPLOADABLE = /^(image|video)\//;

/** Per-process window: the fallback, and the test double. */
export function createMemoryUploadLimiter(
  limit: number,
  now: () => number = Date.now,
): UploadLimiter {
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
        const [ok, wait] = (await redis.eval(
          ACQUIRE_SCRIPT,
          2,
          windowKey,
          BLOCK_KEY,
          limit,
          WINDOW_MS + 5_000,
        )) as [number, number];
        return ok === 1 ? { ok: true } : { ok: false, retryAfterMs: Math.max(1_000, wait) };
      } catch (error) {
        logger.debug('[media] Redis limiter unavailable, using the local window', error);
        return local.acquire();
      }
    },
    async block(retryAfterMs) {
      await local.block(retryAfterMs);
      await getReadyRedis()
        ?.set(BLOCK_KEY, '1', 'PX', Math.max(1_000, Math.round(retryAfterMs)))
        .catch(() => undefined);
    },
  };
}

/** The file Oxy holds for an imported URL. */
export interface ImportedMedia {
  fileId: string;
  mime: string;
  /** `trash` when the user already holds these bytes in their trash. */
  status: string;
}

/** Import `sourceUrl` into `ownerUserId`'s files; rejects with the SDK's error. */
export type MediaImporter = (ownerUserId: string, sourceUrl: string) => Promise<ImportedMedia>;

/** Oxy's import, with Move's service credential. Public, like every migrated post's media. */
export const importWithOxy: MediaImporter = async (ownerUserId, sourceUrl) => {
  const { file } = await getServiceOxyClient().assets.importUserMedia(ownerUserId, sourceUrl, {
    visibility: 'public',
  });
  return { fileId: file.id, mime: file.mime, status: file.status };
};

/** What a rejected import says, read off the SDK's error (`OxyApiError` shape). */
interface ImportFailure {
  status: number;
  code?: string;
  sourceStatus?: number;
  retryAfterMs?: number;
}

function importFailure(error: unknown): ImportFailure | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, code, details } = error as {
    status?: unknown;
    code?: unknown;
    details?: Record<string, unknown>;
  };
  if (typeof status !== 'number' || status === 0) return null;
  const sourceStatus = details?.sourceStatus;
  const retryAfterSeconds = details?.retryAfterSeconds;
  return {
    status,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof sourceStatus === 'number' ? { sourceStatus } : {}),
    ...(typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0
      ? { retryAfterMs: retryAfterSeconds * 1000 }
      : {}),
  };
}

/**
 * True when the file can NEVER be imported, so the entry is dropped and the
 * post goes without it:
 * - 400 `INVALID_SOURCE_URL` (not https, credentials in it) and 422
 *   `SOURCE_URL_REFUSED` (a private address, a redirect to http);
 * - 413 (over Oxy's 40 MiB) and 415 (not an image or video Oxy stores);
 * - 502 `SOURCE_FETCH_FAILED` where the source answered a 4xx other than 408
 *   and 429: the file is gone or forbidden.
 *
 * Anything else — the source's 5xx or timeout (502/504), Oxy's own 5xx, a 409
 * race — is transient and rethrown, so the run retries from its checkpoint.
 */
function isPermanent(failure: ImportFailure): boolean {
  if ([400, 413, 415, 422].includes(failure.status)) return true;
  const source = failure.sourceStatus;
  return (
    failure.status === 502 &&
    source !== undefined &&
    source >= 400 &&
    source < 500 &&
    source !== 408 &&
    source !== 429
  );
}

export interface MediaCopier {
  /** Import each entry; entries that can never be imported are dropped. */
  copy(
    ownerUserId: string,
    media: SourceMedia[],
  ): Promise<Array<SourceMedia & { assetId: string }>>;
}

export function createMediaCopier(deps: {
  limiter: UploadLimiter;
  importMedia?: MediaImporter;
  sleep?: Sleep;
}): MediaCopier {
  const importMedia = deps.importMedia ?? importWithOxy;
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
        await acquire();
        let file: ImportedMedia;
        try {
          file = await importMedia(ownerUserId, entry.url);
        } catch (error) {
          const failure = importFailure(error);
          if (failure?.status === 429) {
            const retryAfterMs = failure.retryAfterMs ?? WINDOW_MS;
            await deps.limiter.block(retryAfterMs);
            throw new MediaRateLimitedError('Oxy is rate limiting media imports', retryAfterMs);
          }
          if (failure && isPermanent(failure)) {
            logger.info('[media] a media file can never be imported; the post goes without it', {
              status: failure.status,
              code: failure.code,
              sourceStatus: failure.sourceStatus,
            });
            continue;
          }
          throw error;
        }
        // The user moved these very bytes to their trash: Move neither brings
        // them back nor hands Mention a file Oxy does not serve.
        if (file.status !== 'active') {
          logger.info('[media] the user holds this file in their trash; the post goes without it');
          continue;
        }
        const mimeType = UPLOADABLE.test(file.mime) ? file.mime : entry.mimeType;
        copied.push({ ...entry, mimeType, assetId: file.fileId });
      }
      return copied;
    },
  };
}
