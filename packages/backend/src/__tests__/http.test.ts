import { describe, expect, test } from 'bun:test';
import { SsrfRejection, type OxyServer } from '@oxy.so/core/server';
import {
  SourceAuthRequiredError,
  SourceRateLimitedError,
  SourceUnavailableError,
  createPublicJsonFetcher,
  parseRetryAfterMs,
  withBackoff,
  DEFAULT_BACKOFF,
  type JsonFetcher,
  type JsonResponse,
} from '../sources/http';
import { OxyApiError } from '@oxy.so/core';
import {
  createMediaCopier,
  createMemoryUploadLimiter,
  MediaRateLimitedError,
  type ImportedMedia,
} from '../destinations/media';
import { createInstanceFetchSigner } from '../destinations/oxy';

function scripted(responses: Array<Partial<JsonResponse>>): JsonFetcher & { calls: number } {
  const fetcher = (async () => {
    const next = responses[Math.min(fetcher.calls, responses.length - 1)];
    fetcher.calls++;
    return { status: 200, headers: {}, body: {}, ...next };
  }) as unknown as JsonFetcher & { calls: number };
  fetcher.calls = 0;
  return fetcher;
}

const noSleep = async () => undefined;
const policy = { ...DEFAULT_BACKOFF, minIntervalMs: 0 };

describe('per-platform backoff', () => {
  test('a short 429 is retried inline, honouring Retry-After', async () => {
    const waits: number[] = [];
    const fetcher = scripted([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { ok: true } },
    ]);
    const wrapped = withBackoff(fetcher, policy, async (ms) => {
      waits.push(ms);
    });
    const response = await wrapped('https://x.example/a', { accept: 'application/json' });
    expect(response.body).toEqual({ ok: true });
    expect(waits).toEqual([2_000]);
  });

  test('a long 429 pauses the job instead of holding the worker', async () => {
    const wrapped = withBackoff(
      scripted([{ status: 429, headers: { 'retry-after': '600' } }]),
      policy,
      noSleep,
    );
    const error = await wrapped('https://x.example/a', { accept: '*/*' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SourceRateLimitedError);
    expect((error as SourceRateLimitedError).retryAfterMs).toBe(600_000);
  });

  test('404/410 are permanent', async () => {
    const wrapped = withBackoff(scripted([{ status: 410 }]), policy, noSleep);
    await expect(wrapped('https://x.example/a', { accept: '*/*' })).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });

  test('5xx is retried up to the attempt budget', async () => {
    const fetcher = scripted([{ status: 503 }, { status: 503 }, { status: 200, body: 1 }]);
    const response = await withBackoff(
      fetcher,
      policy,
      noSleep,
    )('https://x.example/a', { accept: '*/*' });
    expect(response.body).toBe(1);
    expect(fetcher.calls).toBe(3);
  });

  test('a non-public address is permanent, never retried', async () => {
    let calls = 0;
    const blocked: JsonFetcher = async () => {
      calls++;
      throw new SsrfRejection('private address');
    };
    await expect(
      withBackoff(blocked, policy, noSleep)('https://x.example/a', { accept: '*/*' }),
    ).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(calls).toBe(1);
  });

  test('parseRetryAfterMs reads seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs(new Date(1_000_000 + 5_000).toUTCString(), 1_000_000)).toBe(5_000);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});

describe('media import behind the shared upload limiter', () => {
  const media = [{ url: 'https://cdn.example/a.png', mimeType: 'image/png' }];
  const imported = (fileId: string): ImportedMedia => ({
    fileId,
    mime: 'image/png',
    status: 'active',
  });
  /** The error the SDK rejects with, shaped as Oxy's error body makes it. */
  const oxyError = (status: number, code: string, details?: Record<string, unknown>) =>
    new OxyApiError(`HTTP ${status}`, { status, code, ...(details ? { details } : {}) });

  test('the window caps imports; an exhausted window pauses instead of failing', async () => {
    let now = 60_000 * 10;
    const limiter = createMemoryUploadLimiter(2, () => now);
    let imports = 0;
    const copier = createMediaCopier({
      limiter,
      importMedia: async () => imported(`f${++imports}`),
      sleep: noSleep,
    });
    await copier.copy('u1', media);
    await copier.copy('u1', media);
    const error = await copier.copy('u1', media).catch((caught) => caught);
    expect(error).toBeInstanceOf(MediaRateLimitedError);
    expect(imports).toBe(2);
    now += 60_000;
    await copier.copy('u1', media);
    expect(imports).toBe(3);
  });

  test('Oxy is handed the source URL for the user, never bytes', async () => {
    const calls: Array<[string, string]> = [];
    const copier = createMediaCopier({
      limiter: createMemoryUploadLimiter(30),
      importMedia: async (owner, url) => {
        calls.push([owner, url]);
        return { fileId: 'f1', mime: 'image/webp', status: 'active' };
      },
      sleep: noSleep,
    });
    const result = await copier.copy('u1', [{ ...media[0], alt: 'a cat' }]);
    expect(calls).toEqual([['u1', 'https://cdn.example/a.png']]);
    // The type Oxy stored wins over the source's guess.
    expect(result).toEqual([
      { url: 'https://cdn.example/a.png', mimeType: 'image/webp', alt: 'a cat', assetId: 'f1' },
    ]);
  });

  test("Oxy's 429 blocks the whole limiter for the time it names and pauses", async () => {
    const now = 0;
    const limiter = createMemoryUploadLimiter(30, () => now);
    const copier = createMediaCopier({
      limiter,
      importMedia: async () => {
        throw oxyError(429, 'RATE_LIMITED', { retryAfterSeconds: 120 });
      },
      sleep: noSleep,
    });
    const error = await copier.copy('u1', media).catch((caught) => caught);
    expect(error).toBeInstanceOf(MediaRateLimitedError);
    expect((error as MediaRateLimitedError).retryAfterMs).toBe(120_000);
    expect(await limiter.acquire()).toEqual({ ok: false, retryAfterMs: 120_000 });
  });

  test('what Mention cannot import is dropped before Oxy is asked', async () => {
    let imports = 0;
    const copier = createMediaCopier({
      limiter: createMemoryUploadLimiter(30),
      importMedia: async () => imported(`f${++imports}`),
      sleep: noSleep,
    });
    const result = await copier.copy('u1', [
      { url: 'https://cdn.example/a.mp3', mimeType: 'audio/mpeg' },
      { url: 'https://cdn.example/a.pdf', mimeType: 'application/pdf' },
    ]);
    expect(result).toEqual([]);
    expect(imports).toBe(0);
  });

  test.each([
    ['not https', oxyError(400, 'INVALID_SOURCE_URL')],
    ['a private address', oxyError(422, 'SOURCE_URL_REFUSED')],
    ['over 40 MiB', oxyError(413, 'PAYLOAD_TOO_LARGE')],
    ['not an image or video', oxyError(415, 'UNSUPPORTED_MEDIA_TYPE')],
    ['gone at the source', oxyError(502, 'SOURCE_FETCH_FAILED', { sourceStatus: 404 })],
    ['forbidden at the source', oxyError(502, 'SOURCE_FETCH_FAILED', { sourceStatus: 403 })],
  ])(
    'a file that can never be imported (%s) is dropped, and the rest go on',
    async (_, failure) => {
      let calls = 0;
      const copier = createMediaCopier({
        limiter: createMemoryUploadLimiter(30),
        importMedia: async () => {
          calls++;
          if (calls === 1) throw failure;
          return imported('f2');
        },
        sleep: noSleep,
      });
      const result = await copier.copy('u1', [
        media[0],
        { url: 'https://cdn.example/b.png', mimeType: 'image/png' },
      ]);
      expect(result.map((entry) => entry.assetId)).toEqual(['f2']);
    },
  );

  test.each([
    ['the source failing', oxyError(502, 'SOURCE_FETCH_FAILED', { sourceStatus: 503 })],
    ['the source rate limiting', oxyError(502, 'SOURCE_FETCH_FAILED', { sourceStatus: 429 })],
    ['the source unreachable', oxyError(502, 'SOURCE_FETCH_FAILED')],
    ['the source timing out', oxyError(504, 'SOURCE_FETCH_TIMEOUT')],
    ['an import race', oxyError(409, 'IMPORT_RACED')],
    ['Oxy failing', oxyError(500, 'INTERNAL_ERROR')],
    ['a missing scope', oxyError(403, 'FORBIDDEN')],
  ])('%s is rethrown, so the run retries from its checkpoint', async (_, failure) => {
    const copier = createMediaCopier({
      limiter: createMemoryUploadLimiter(30),
      importMedia: async () => {
        throw failure;
      },
      sleep: noSleep,
    });
    expect(await copier.copy('u1', media).catch((caught) => caught)).toBe(failure);
  });

  test('bytes the user keeps in their trash are neither revived nor handed to Mention', async () => {
    const copier = createMediaCopier({
      limiter: createMemoryUploadLimiter(30),
      importMedia: async () => ({ fileId: 'f1', mime: 'image/png', status: 'trash' }),
      sleep: noSleep,
    });
    expect(await copier.copy('u1', media)).toEqual([]);
  });
});

describe('signed reads through Oxy', () => {
  const signedHeaders = {
    Host: 'mastodon.example',
    Date: 'Sat, 26 Sep 2026 00:00:00 GMT',
    Signature:
      'keyId="https://oxy.so/ap/users/instance#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="c2ln"',
  };

  test('the signer asks Oxy to sign exactly that URL and returns the three headers', async () => {
    const requests: Array<{ method: string; url: string; data: unknown }> = [];
    const oxy = {
      serviceRequest: async (method: string, url: string, data?: unknown) => {
        requests.push({ method, url, data });
        return { keyId: 'https://oxy.so/ap/users/instance#main-key', headers: signedHeaders };
      },
    } as unknown as Pick<OxyServer, 'serviceRequest'>;
    const headers = await createInstanceFetchSigner(oxy)(
      'https://mastodon.example/users/ada/outbox?page=true',
    );
    expect(headers).toEqual(signedHeaders);
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/federation/instance-fetch/sign',
        data: { url: 'https://mastodon.example/users/ada/outbox?page=true' },
      },
    ]);
  });

  test("Oxy's 429 pauses the job; a malformed answer is not sent", async () => {
    const limited = {
      serviceRequest: async () => {
        throw Object.assign(new Error('Too many requests'), { status: 429 });
      },
    } as unknown as Pick<OxyServer, 'serviceRequest'>;
    await expect(createInstanceFetchSigner(limited)('https://m.example/a')).rejects.toBeInstanceOf(
      SourceRateLimitedError,
    );
    const malformed = {
      serviceRequest: async () => ({
        keyId: 'https://oxy.so/ap/users/instance#main-key',
        headers: { ...signedHeaders, Digest: 'x' },
      }),
    } as unknown as Pick<OxyServer, 'serviceRequest'>;
    await expect(createInstanceFetchSigner(malformed)('https://m.example/a')).rejects.toThrow();
    // Before the scope is granted (or for a URL Oxy refuses) the read is simply
    // unsigned-refused, so the actor can still fall back to the REST lookup.
    const forbidden = {
      serviceRequest: async () => {
        throw Object.assign(new Error('Missing required scope'), { status: 403 });
      },
    } as unknown as Pick<OxyServer, 'serviceRequest'>;
    await expect(
      createInstanceFetchSigner(forbidden)('https://m.example/a'),
    ).rejects.toBeInstanceOf(SourceAuthRequiredError);
  });

  test('a fetcher with no signer refuses a signed read as authorized-fetch, before any network', async () => {
    await expect(
      createPublicJsonFetcher()('https://m.example/a', { accept: '*/*', signed: true }),
    ).rejects.toBeInstanceOf(SourceAuthRequiredError);
  });

  test('the backoff never retries an authorized-fetch refusal or a paused signing budget', async () => {
    for (const failure of [
      new SourceAuthRequiredError('refused', 401),
      new SourceRateLimitedError('budget', 60_000),
    ]) {
      let calls = 0;
      const failing: JsonFetcher = async () => {
        calls++;
        throw failure;
      };
      await expect(
        withBackoff(
          failing,
          policy,
          noSleep,
        )('https://m.example/a', { accept: '*/*', signed: true }),
      ).rejects.toBe(failure);
      expect(calls).toBe(1);
    }
  });
});
