/**
 * Move's side of the Mention ingest contract, checked against Mention itself:
 *
 * 1. Responses copied LITERALLY from Mention's route tests
 *    (`packages/backend/src/__tests__/routes/imports.test.ts`) parse with Move's
 *    response schemas.
 * 2. Every request Move builds parses with a COPY of Mention's request schema
 *    (`packages/backend/src/routes/imports.ts`, `itemSchema` / `batchSchema`),
 *    written out independently of `mentionContract.ts` so a drift in either
 *    shows here.
 * 3. The client splits by item count AND by body size (Mention: ≤ 50, 1 MB).
 *
 * Source: Mention `e0ee03747 docs(imports): the content-import contract for Oxy Move`.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  mentionBatchResponseSchema,
  mentionLookupResponseSchema,
  mentionUndoResponseSchema,
} from '../destinations/mentionContract';
import { MentionDestination, toMentionItem } from '../destinations/mention';
import type { PreparedItem } from '../destinations/types';

// ---- Mention's request schema, transcribed from routes/imports.ts ----------
// (config.posts.maxTextLength = 25_000, maxAltTextLength = 2_000,
//  MAX_IMPORT_MEDIA_PER_ITEM = MAX_IMPORT_LINKS_PER_ITEM = 10, MAX_IMPORT_BATCH_ITEMS = 50)
const opaqueId = () => z.string().trim().min(1).max(512);
const httpUrl = () =>
  z.string().trim().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  });
const MENTION_IMPORT_PLATFORMS = ['mastodon', 'bluesky', 'threads', 'instagram', 'x', 'facebook', 'medium', 'substack'] as const;
const mentionItemSchema = z.object({
  sourceId: opaqueId(),
  sourceUrl: httpUrl(),
  createdAt: z.iso.datetime({ offset: true }),
  text: z.string().max(25_000).default(''),
  contentWarning: z.string().trim().max(500).optional(),
  language: z.string().trim().min(2).max(35).optional(),
  visibility: z.enum(['public', 'followers_only']),
  replyToSourceId: opaqueId().optional(),
  quoteSourceId: opaqueId().optional(),
  media: z.array(z.object({ assetId: opaqueId(), alt: z.string().max(4_000).optional() })).max(10).default([]),
  article: z.object({ title: z.string().optional(), body: z.string().optional() }).optional(),
  links: z.array(httpUrl()).max(10).optional(),
});
const mentionBatchSchema = z.object({
  platform: z.enum(MENTION_IMPORT_PLATFORMS),
  batchId: opaqueId(),
  items: z.array(mentionItemSchema).min(1).max(50),
});

function item(overrides: Partial<PreparedItem> = {}): PreparedItem {
  return {
    kind: 'post',
    sourceId: 'https://mastodon.social/users/Gargron/statuses/1',
    sourceUrl: 'https://mastodon.social/@Gargron/1',
    createdAt: '2019-03-04T05:06:07.123Z',
    text: 'hello',
    visibility: 'public',
    media: [],
    ...overrides,
  };
}

describe('Mention responses, copied literally from Mention\'s tests', () => {
  test('batch results: existing, deferred, failed', () => {
    const literal = {
      results: [
        { sourceId: 'again', status: 'existing', postId: '0199a0c4-0000-7000-8000-000000000001' },
        { sourceId: 'orphan-reply', status: 'deferred', error: 'parent_not_imported' },
        { sourceId: 'orphan-quote', status: 'deferred', error: 'quote_not_imported' },
        { sourceId: 'missing-media', status: 'failed', error: 'media_not_found' },
      ],
    };
    const parsed = mentionBatchResponseSchema.parse(literal);
    expect(parsed.results.map((result) => result.status)).toEqual(['existing', 'deferred', 'deferred', 'failed']);
  });

  test('undo: { deleted, failed }', () => {
    expect(mentionUndoResponseSchema.parse({ deleted: 2, failed: 0 })).toEqual({ deleted: 2, failed: 0 });
    expect(() => mentionUndoResponseSchema.parse({ deleted: 2 })).toThrow();
  });

  test('lookup: { imported, federated } — Move reads `imported`', () => {
    const noteId = 'https://mastodon.example/users/alice/statuses/1727000000000';
    const literal = {
      imported: { 'looked-up': '0199a0c4-0000-7000-8000-000000000002' },
      federated: {
        [noteId]: { postId: 'p1', actorUri: 'https://mastodon.example/users/alice', url: `${noteId}/web`, oxyUserId: null },
      },
    };
    expect(mentionLookupResponseSchema.parse(literal)).toEqual({ imported: literal.imported });
    expect(() => mentionLookupResponseSchema.parse({ federated: {} })).toThrow();
  });
});

describe('requests Move builds pass Mention\'s own schema', () => {
  const cases: Array<[string, PreparedItem]> = [
    ['plain', item()],
    ['unlisted becomes public', item({ visibility: 'unlisted' })],
    ['content warning clamped to 500', item({ contentWarning: 'x'.repeat(900) })],
    ['sensitive without a warning', item({ sensitive: true })],
    ['media: assetId + alt only, alt clamped', item({ media: [{ url: 'https://cdn.example/a.jpg', mimeType: 'image/jpeg', alt: 'a'.repeat(5_000), assetId: 'asset-1' }] })],
    ['eleven links clamped to ten, non-http dropped', item({ links: [...Array.from({ length: 11 }, (_, i) => `https://l.example/${i}`), 'at://did:plc:x/app.bsky.feed.post/1'] })],
    ['article: body moves out of text', item({ kind: 'article', text: 'Long body', article: { title: 'Title', summary: 'Teaser' } })],
    ['self-reply and self-quote', item({ replyToSourceId: 'https://m.example/s/0', quoteSourceId: 'at://did:plc:a/app.bsky.feed.post/1' })],
    ['text over the limit clamped, links included', item({ text: 'x'.repeat(30_000), links: ['https://l.example/a'] })],
  ];
  for (const [label, prepared] of cases) {
    test(label, () => {
      const request = { platform: 'mastodon', batchId: 'job-1', items: [toMentionItem(prepared)] };
      expect(mentionBatchSchema.safeParse(request).success).toBe(true);
    });
  }

  test('mapped values', () => {
    expect(toMentionItem(item({ visibility: 'unlisted' })).visibility).toBe('public');
    expect(toMentionItem(item({ visibility: 'followers' })).visibility).toBe('followers_only');
    expect(toMentionItem(item({ sensitive: true })).contentWarning).toBe('Sensitive content');
    const article = toMentionItem(item({ kind: 'article', text: 'Long body', article: { title: 'Title', summary: 'Teaser' } }));
    expect(article.text).toBe('Teaser');
    expect(article.article).toEqual({ title: 'Title', body: 'Long body' });
    expect(Object.keys(toMentionItem(item({ media: [{ url: 'https://c/a.png', mimeType: 'image/png', assetId: 'x' }] })).media[0])).toEqual(['assetId']);
  });
});

describe('the Mention client', () => {
  function client(respond: (body: { items: Array<{ sourceId: string }> } | undefined, url: string) => unknown) {
    const requests: Array<{ url: string; bytes: number; body?: { items: Array<{ sourceId: string }> } }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const raw = typeof init?.body === 'string' ? init.body : undefined;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ url, bytes: raw ? Buffer.byteLength(raw) : 0, body });
      return new Response(JSON.stringify(respond(body, url)), { status: 200 });
    }) as unknown as typeof fetch;
    const destination = new MentionDestination({ baseUrl: 'https://api.mention.test', oxy: { serviceToken: async () => 'tok' }, fetch: fakeFetch });
    return { destination, requests };
  }
  const created = (body?: { items: Array<{ sourceId: string }> }) => ({
    results: (body?.items ?? []).map((entry) => ({ sourceId: entry.sourceId, status: 'created', postId: `p-${entry.sourceId}` })),
  });

  test('splits 50 large items into requests under Mention\'s 1 MB body limit, in order', async () => {
    const { destination, requests } = client(created);
    const items = Array.from({ length: 50 }, (_, i) => item({ sourceId: `s${i}`, text: 'é'.repeat(12_000) }));
    const results = await destination.deliver({ oxyUserId: 'u', platform: 'mastodon', batchId: 'job', items });
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => request.bytes <= 1_000_000)).toBe(true);
    expect(requests.flatMap((request) => request.body!.items.map((entry) => entry.sourceId))).toEqual(items.map((entry) => entry.sourceId));
    expect(results.every((result) => result.status === 'created')).toBe(true);
  });

  test('negative control: small items stay in ONE request', async () => {
    const { destination, requests } = client(created);
    await destination.deliver({ oxyUserId: 'u', platform: 'mastodon', batchId: 'job', items: Array.from({ length: 50 }, (_, i) => item({ sourceId: `s${i}` })) });
    expect(requests).toHaveLength(1);
  });

  test('deferred passes through; an item missing from the response is a failure', async () => {
    const { destination } = client((body) => ({
      results: [{ sourceId: body!.items[0].sourceId, status: 'deferred', error: 'parent_not_imported' }],
    }));
    const results = await destination.deliver({ oxyUserId: 'u', platform: 'mastodon', batchId: 'job', items: [item({ sourceId: 'a' }), item({ sourceId: 'b' })] });
    expect(results).toEqual([
      { sourceId: 'a', status: 'deferred', error: 'parent_not_imported' },
      { sourceId: 'b', status: 'failed', error: 'missing-from-response' },
    ]);
  });

  test('lookup sends `sourceIds` and reads `imported`', async () => {
    const { destination, requests } = client(() => ({ imported: { a: 'p1' }, federated: {} }));
    const found = await destination.lookupImported({ oxyUserId: 'u', platform: 'bluesky', sourceIds: ['a', 'b', 'a'] });
    expect([...found]).toEqual(['a']);
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe('/imports/v1/lookup');
    expect(url.searchParams.get('platform')).toBe('bluesky');
    expect(url.searchParams.getAll('sourceIds')).toEqual(['a', 'b']);
  });
});
