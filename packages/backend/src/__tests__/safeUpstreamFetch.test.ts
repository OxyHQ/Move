import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import * as realCoreServer from '@oxy.so/core/server';
import type { SafeFetchOptions, SafeFetchResult } from '@oxy.so/core/server';

// `publicGet` is a redirect loop over the SDK's `safeFetch`. The real one
// refuses every address a test server can listen on, so the loop's own
// behaviour is driven through a stand-in; by default it IS the real one, and
// the rest of the module stays real for any test file sharing this process.
type SafeFetch = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>;
let safeFetchImpl: SafeFetch = realCoreServer.safeFetch;
const calls: Array<{ url: string; options: SafeFetchOptions | undefined }> = [];
mock.module('@oxy.so/core/server', () => ({
  ...realCoreServer,
  safeFetch: (url: string, options?: SafeFetchOptions) => {
    calls.push({ url, options });
    return safeFetchImpl(url, options);
  },
}));

let publicGet: typeof import('../utils/safeUpstreamFetch').publicGet;
let ResponseTooLargeError: typeof import('../utils/safeUpstreamFetch').ResponseTooLargeError;
beforeAll(async () => {
  ({ publicGet, ResponseTooLargeError } = await import('../utils/safeUpstreamFetch.js'));
});

afterEach(() => {
  safeFetchImpl = realCoreServer.safeFetch;
  calls.length = 0;
});

function answer(status: number, headers: IncomingHttpHeaders, chunks: Buffer[] = []) {
  const response = Readable.from(chunks) as unknown as IncomingMessage;
  return { response, status, headers, finalUrl: '' } satisfies SafeFetchResult;
}

const OPTIONS = { accept: 'application/activity+json', maxBytes: 64, timeoutMs: 5_000 };

describe('publicGet', () => {
  test('a private address is refused by the SDK guard, before any request', async () => {
    await expect(publicGet('http://127.0.0.1:9/users/ada', OPTIONS)).rejects.toBeInstanceOf(
      realCoreServer.SsrfRejection,
    );
  });

  test('each redirect hop is its own guarded fetch, signed for exactly that URL', async () => {
    safeFetchImpl = async (url) =>
      url === 'https://a.example/users/ada'
        ? answer(302, { location: '/ap/ada' })
        : answer(200, { 'content-type': 'application/json' }, [Buffer.from('{"ok":true}')]);
    const signed: string[] = [];
    const result = await publicGet('https://a.example/users/ada', {
      ...OPTIONS,
      signHeaders: async (url) => {
        signed.push(url);
        return { Signature: `sig:${url}` };
      },
    });
    expect(signed).toEqual(['https://a.example/users/ada', 'https://a.example/ap/ada']);
    expect(
      calls.map(({ url, options }) => [url, options?.redirect, options?.headers?.Signature]),
    ).toEqual([
      ['https://a.example/users/ada', 'manual', 'sig:https://a.example/users/ada'],
      ['https://a.example/ap/ada', 'manual', 'sig:https://a.example/ap/ada'],
    ]);
    expect(calls[0]?.options?.headers?.Accept).toBe('application/activity+json');
    expect(result.status).toBe(200);
    expect(result.body?.toString()).toBe('{"ok":true}');
  });

  test('a non-2xx answer is returned with its headers and no body', async () => {
    safeFetchImpl = async () => answer(429, { 'retry-after': '30' }, [Buffer.from('slow down')]);
    const result = await publicGet('https://a.example/x', OPTIONS);
    expect(result).toEqual({ status: 429, headers: { 'retry-after': '30' } });
  });

  test('a body past the cap is refused, declared or streamed', async () => {
    safeFetchImpl = async () => answer(200, { 'content-length': '65' }, [Buffer.alloc(65)]);
    await expect(publicGet('https://a.example/x', OPTIONS)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    safeFetchImpl = async () => answer(200, {}, [Buffer.alloc(40), Buffer.alloc(40)]);
    await expect(publicGet('https://a.example/x', OPTIONS)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  test('more than three redirects is an upstream error', async () => {
    safeFetchImpl = async (url) => answer(301, { location: `${url}/next` });
    await expect(publicGet('https://a.example/x', OPTIONS)).rejects.toBeInstanceOf(
      realCoreServer.UpstreamError,
    );
    expect(calls).toHaveLength(4);
  });
});
