import { describe, expect, test } from 'bun:test';
import { SsrfRejection } from '@oxy.so/core/server';
import type { OxyServices } from '@oxy.so/core';
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
import { createMediaCopier, createMemoryUploadLimiter, MediaRateLimitedError } from '../destinations/media';
import { OxyUploadError } from '../utils/oxyHelpers';
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
    const fetcher = scripted([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: { ok: true } }]);
    const wrapped = withBackoff(fetcher, policy, async (ms) => { waits.push(ms); });
    const response = await wrapped('https://x.example/a', { accept: 'application/json' });
    expect(response.body).toEqual({ ok: true });
    expect(waits).toEqual([2_000]);
  });

  test('a long 429 pauses the job instead of holding the worker', async () => {
    const wrapped = withBackoff(scripted([{ status: 429, headers: { 'retry-after': '600' } }]), policy, noSleep);
    const error = await wrapped('https://x.example/a', { accept: '*/*' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SourceRateLimitedError);
    expect((error as SourceRateLimitedError).retryAfterMs).toBe(600_000);
  });

  test('404/410 are permanent', async () => {
    const wrapped = withBackoff(scripted([{ status: 410 }]), policy, noSleep);
    await expect(wrapped('https://x.example/a', { accept: '*/*' })).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  test('5xx is retried up to the attempt budget', async () => {
    const fetcher = scripted([{ status: 503 }, { status: 503 }, { status: 200, body: 1 }]);
    const response = await withBackoff(fetcher, policy, noSleep)('https://x.example/a', { accept: '*/*' });
    expect(response.body).toBe(1);
    expect(fetcher.calls).toBe(3);
  });

  test('a non-public address is permanent, never retried', async () => {
    let calls = 0;
    const blocked: JsonFetcher = async () => {
      calls++;
      throw new SsrfRejection('private address');
    };
    await expect(withBackoff(blocked, policy, noSleep)('https://x.example/a', { accept: '*/*' })).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(calls).toBe(1);
  });

  test('parseRetryAfterMs reads seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs(new Date(1_000_000 + 5_000).toUTCString(), 1_000_000)).toBe(5_000);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});

describe('media copy behind the shared upload limiter', () => {
  const download = async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' });
  const media = [{ url: 'https://cdn.example/a.png', mimeType: 'image/png' }];

  test('the window caps uploads; an exhausted window pauses instead of failing', async () => {
    let now = 60_000 * 10;
    const limiter = createMemoryUploadLimiter(2, () => now);
    let uploads = 0;
    const copier = createMediaCopier({
      limiter,
      download,
      upload: async () => ({ fileId: `f${++uploads}` }),
      sleep: noSleep,
    });
    await copier.copy('u1', media);
    await copier.copy('u1', media);
    const error = await copier.copy('u1', media).catch((caught) => caught);
    expect(error).toBeInstanceOf(MediaRateLimitedError);
    expect(uploads).toBe(2);
    now += 60_000;
    await copier.copy('u1', media);
    expect(uploads).toBe(3);
  });

  test('Oxy 429 blocks the whole limiter until Retry-After and pauses', async () => {
    const now = 0;
    const limiter = createMemoryUploadLimiter(30, () => now);
    const copier = createMediaCopier({
      limiter,
      download,
      upload: async () => { throw new OxyUploadError('slow down', 429, '120'); },
      sleep: noSleep,
    });
    const error = await copier.copy('u1', media).catch((caught) => caught);
    expect(error).toBeInstanceOf(MediaRateLimitedError);
    expect((error as MediaRateLimitedError).retryAfterMs).toBe(120_000);
    expect(await limiter.acquire()).toEqual({ ok: false, retryAfterMs: 120_000 });
  });

  test('what Mention cannot import is dropped before it is downloaded', async () => {
    let downloads = 0;
    let uploads = 0;
    const copier = createMediaCopier({
      limiter: createMemoryUploadLimiter(30),
      download: async () => {
        downloads++;
        return { buffer: Buffer.from('x'), contentType: 'audio/mpeg' };
      },
      upload: async () => ({ fileId: `f${++uploads}` }),
      sleep: noSleep,
    });
    const result = await copier.copy('u1', [
      { url: 'https://cdn.example/a.mp3', mimeType: 'audio/mpeg' },
      { url: 'https://cdn.example/a.pdf', mimeType: 'application/pdf' },
    ]);
    expect(result).toEqual([]);
    expect(downloads).toBe(0);
    expect(uploads).toBe(0);
  });

  test('a file that can never be copied (gone, too large) is dropped', async () => {
    const copier = createMediaCopier({
      limiter: createMemoryUploadLimiter(30),
      download: async () => null,
      upload: async () => { throw new Error('never called'); },
      sleep: noSleep,
    });
    expect(await copier.copy('u1', media)).toEqual([]);
  });
});

describe('signed reads through Oxy', () => {
  const signedHeaders = {
    Host: 'mastodon.example',
    Date: 'Sat, 26 Sep 2026 00:00:00 GMT',
    Signature: 'keyId="https://oxy.so/ap/users/instance#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="c2ln"',
  };

  test('the signer asks Oxy to sign exactly that URL and returns the three headers', async () => {
    const requests: Array<{ method: string; url: string; data: unknown }> = [];
    const oxy = {
      makeServiceRequest: async (method: string, url: string, data?: unknown) => {
        requests.push({ method, url, data });
        return { keyId: 'https://oxy.so/ap/users/instance#main-key', headers: signedHeaders };
      },
    } as unknown as Pick<OxyServices, 'makeServiceRequest'>;
    const headers = await createInstanceFetchSigner(oxy)('https://mastodon.example/users/ada/outbox?page=true');
    expect(headers).toEqual(signedHeaders);
    expect(requests).toEqual([
      { method: 'POST', url: '/federation/instance-fetch/sign', data: { url: 'https://mastodon.example/users/ada/outbox?page=true' } },
    ]);
  });

  test("Oxy's 429 pauses the job; a malformed answer is not sent", async () => {
    const limited = {
      makeServiceRequest: async () => {
        throw Object.assign(new Error('Too many requests'), { status: 429 });
      },
    } as unknown as Pick<OxyServices, 'makeServiceRequest'>;
    await expect(createInstanceFetchSigner(limited)('https://m.example/a')).rejects.toBeInstanceOf(SourceRateLimitedError);
    const malformed = {
      makeServiceRequest: async () => ({ keyId: 'https://oxy.so/ap/users/instance#main-key', headers: { ...signedHeaders, Digest: 'x' } }),
    } as unknown as Pick<OxyServices, 'makeServiceRequest'>;
    await expect(createInstanceFetchSigner(malformed)('https://m.example/a')).rejects.toThrow();
  });

  test('a fetcher with no signer refuses a signed read as authorized-fetch, before any network', async () => {
    await expect(createPublicJsonFetcher()('https://m.example/a', { accept: '*/*', signed: true })).rejects.toBeInstanceOf(SourceAuthRequiredError);
  });

  test('the backoff never retries an authorized-fetch refusal or a paused signing budget', async () => {
    for (const failure of [new SourceAuthRequiredError('refused', 401), new SourceRateLimitedError('budget', 60_000)]) {
      let calls = 0;
      const failing: JsonFetcher = async () => {
        calls++;
        throw failure;
      };
      await expect(withBackoff(failing, policy, noSleep)('https://m.example/a', { accept: '*/*', signed: true })).rejects.toBe(failure);
      expect(calls).toBe(1);
    }
  });
});
