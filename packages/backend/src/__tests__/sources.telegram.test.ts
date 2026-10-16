import { describe, expect, test } from 'bun:test';
import { DEFAULT_JOB_OPTIONS } from '@move/shared-types';
import { TelegramExportError } from '../connectors/telegram/exportReader';
import { bufferRangeReader, openZip } from '../connectors/upload/zipArchive';
import {
  TELEGRAM_MEDIA_URL_PREFIX,
  openTelegramSource,
  type TelegramCursor,
  type TelegramSource,
} from '../sources/telegram';
import type { Positioned, SkippedItem, SourceItem } from '../sources/types';
import { buildZip, type ZipFile } from './helpers/zipFixture';

// Synthetic export: every name, id and text below is made up.
const CHANNEL = -1002033379878;
const CHANNEL_ID = '2033379878';
const FOLDER = 'ChatExport_2024-01-01/';
const T0 = 1_704_070_800; // 2024-01-01T01:00:00Z

type Message = Record<string, unknown>;
let nextId = 1;
function msg(fields: Message = {}): Message {
  const id = (fields.id as number | undefined) ?? nextId++;
  const unix = (fields.unix as number | undefined) ?? T0 + id * 60;
  const { unix: _unix, ...rest } = fields;
  return {
    id,
    type: 'message',
    // The exporting machine's local time: deliberately three hours off.
    date: new Date((unix + 3 * 3600) * 1000).toISOString().slice(0, 19),
    date_unixtime: String(unix),
    from: 'Test Channel',
    from_id: `channel${CHANNEL_ID}`,
    text: '',
    text_entities: [],
    ...rest,
  };
}
function text(value: string): Message {
  return { text: value, text_entities: [{ type: 'plain', text: value }] };
}

interface ExportSpec {
  header?: Record<string, unknown>;
  messages: Message[];
  files?: ZipFile[];
  folder?: string;
}

async function exportZip(spec: ExportSpec) {
  const folder = spec.folder ?? FOLDER;
  const result = {
    name: 'Test Channel',
    type: 'public_channel',
    id: CHANNEL,
    ...spec.header,
    messages: spec.messages,
  };
  const files: ZipFile[] = [
    { path: `${folder}result.json`, data: JSON.stringify(result, null, 1) },
    ...(spec.files ?? []).map((file) => ({ ...file, path: `${folder}${file.path}` })),
  ];
  return openZip(bufferRangeReader(await buildZip(files)));
}

async function source(spec: ExportSpec, mediaMaxBytes?: number): Promise<TelegramSource> {
  return openTelegramSource(await exportZip(spec), mediaMaxBytes ? { mediaMaxBytes } : {});
}

type Value = Positioned<SourceItem | SkippedItem, TelegramCursor>;
async function collect(
  src: TelegramSource,
  options: Partial<typeof DEFAULT_JOB_OPTIONS> = {},
  cursor: TelegramCursor | null = null,
): Promise<Value[]> {
  const values: Value[] = [];
  for await (const value of src.items({ cursor, options: { ...DEFAULT_JOB_OPTIONS, ...options } }))
    values.push(value);
  return values;
}
const items = (values: Value[]) =>
  values.map((v) => v.value).filter((v): v is SourceItem => v.kind !== 'skipped');

async function exportError(promise: Promise<unknown>): Promise<TelegramExportError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TelegramExportError) return error;
    throw error;
  }
  throw new Error('expected a TelegramExportError');
}

const jpg = (name: string, size = 100): ZipFile => ({
  path: `photos/${name}`,
  data: Buffer.alloc(size, 1),
  compress: false,
});

describe('Telegram export source', () => {
  test('profile, ids and dates (date_unixtime, never the local date)', async () => {
    const src = await source({ messages: [msg({ id: 5, unix: T0, ...text('Hello') })] });
    expect(await src.profile()).toEqual({
      actor: `tg:${CHANNEL_ID}`,
      handle: 'Test Channel',
      displayName: 'Test Channel',
    });
    const values = await collect(src);
    expect(values).toEqual([
      {
        value: {
          kind: 'post',
          sourceId: `${CHANNEL_ID}/5`,
          sourceUrl: `https://t.me/c/${CHANNEL_ID}/5`,
          createdAt: '2024-01-01T01:00:00.000Z',
          text: 'Hello',
          visibility: 'public',
          media: [],
        },
        cursor: { lastMessageId: 5 },
      },
    ]);
    const graph: unknown[] = [];
    for await (const account of src.graph()) graph.push(account);
    expect(graph).toEqual([]);
  });

  test('a private channel imports as followers-only', async () => {
    const src = await source({
      header: { type: 'private_channel', id: 777 },
      messages: [msg({ id: 1, ...text('x') })],
    });
    const [item] = items(await collect(src));
    expect(item.visibility).toBe('followers');
    expect(item.sourceId).toBe('777/1');
  });

  test('an album folds into one item: head id, first non-empty text, cut at 10', async () => {
    const photos = Array.from({ length: 12 }, (_, i) => jpg(`p${i}.jpg`));
    const album = photos.map((photo, i) =>
      msg({
        id: 10 + i,
        unix: T0,
        photo: photo.path,
        ...(i === 1 ? text('Caption on the second') : {}),
      }),
    );
    const src = await source({
      messages: [...album, msg({ id: 30, unix: T0, ...text('same second, no media') })],
      files: photos,
    });
    const values = await collect(src);
    expect(values.map((v) => v.cursor.lastMessageId)).toEqual([19, 21, 30]);
    const [first, second, third] = items(values);
    expect(first.sourceId).toBe(`${CHANNEL_ID}/10`);
    expect(first.text).toBe('Caption on the second');
    expect(first.media).toHaveLength(10);
    expect(first.media[0]).toEqual({
      url: `${TELEGRAM_MEDIA_URL_PREFIX}${encodeURIComponent(`${FOLDER}photos/p0.jpg`)}`,
      mimeType: 'image/jpeg',
    });
    expect(second.sourceId).toBe(`${CHANNEL_ID}/20`);
    expect(second.media).toHaveLength(2);
    expect(third.text).toBe('same second, no media');
  });

  test('service messages are skipped as unsupported', async () => {
    const src = await source({
      messages: [
        msg({ id: 1, type: 'service', action: 'create_channel', title: 'x' }),
        msg({ id: 2, ...text('post') }),
      ],
    });
    const values = await collect(src);
    expect(values[0].value).toEqual({
      kind: 'skipped',
      sourceId: `${CHANNEL_ID}/1`,
      reason: 'unsupported',
    });
    expect(items(values).map((i) => i.text)).toEqual(['post']);
  });

  test('forwards: skipped by default, prefixed when boosts are included', async () => {
    const spec = {
      messages: [msg({ id: 1, forwarded_from: 'Other Channel', ...text('their words') })],
    };
    const off = await collect(await source(spec));
    expect(off[0].value).toMatchObject({ kind: 'skipped', reason: 'boost-disabled' });
    const on = items(await collect(await source(spec), { includeBoosts: true }));
    expect(on[0].text).toBe('Forwarded from Other Channel:\n\ntheir words');
  });

  test('a reply quotes the ALBUM HEAD of the message it answers', async () => {
    const photos = [jpg('a.jpg'), jpg('b.jpg')];
    const src = await source({
      messages: [
        msg({ id: 1, unix: T0, photo: photos[0].path, ...text('album') }),
        msg({ id: 2, unix: T0, photo: photos[1].path }),
        msg({ id: 3, reply_to_message_id: 2, ...text('about the second photo') }),
        msg({ id: 4, type: 'service', action: 'pin_message' }),
        msg({ id: 5, reply_to_message_id: 4, ...text('reply to a service message') }),
        msg({ id: 6, reply_to_message_id: 999, ...text('reply to a deleted message') }),
        msg({
          id: 7,
          reply_to_message_id: 1,
          reply_to_peer_id: 'channel42',
          ...text('reply into another chat'),
        }),
      ],
      files: photos,
    });
    const [, reply, toService, toDeleted, foreign] = items(await collect(src));
    expect(reply.quoteSourceId).toBe(`${CHANNEL_ID}/1`);
    expect(toService.quoteSourceId).toBeUndefined();
    expect(toDeleted.quoteSourceId).toBeUndefined();
    expect(foreign.quoteSourceId).toBeUndefined();
  });

  test('media: placeholders, voice, audio, documents and .tgs are dropped and counted', async () => {
    const files = [
      jpg('ok.jpg'),
      { path: 'video_files/v.mp4', data: Buffer.alloc(50, 2), compress: false },
      { path: 'stickers/s.webp', data: Buffer.alloc(50, 3), compress: false },
      { path: 'stickers/s.tgs', data: Buffer.alloc(50, 4) },
      { path: 'voice_messages/a.ogg', data: Buffer.alloc(50, 5) },
      { path: 'files/doc.pdf', data: Buffer.alloc(50, 6) },
    ];
    const src = await source({
      messages: [
        msg({
          id: 1,
          photo: '(File not included. Change data exporting settings to download.)',
          ...text('with text'),
        }),
        msg({
          id: 2,
          photo: '(File exceeds maximum size. Change data exporting settings to download.)',
        }),
        msg({ id: 3, file: 'video_files/v.mp4', media_type: 'video_file', mime_type: 'video/mp4' }),
        msg({ id: 4, file: 'stickers/s.webp', media_type: 'sticker' }),
        msg({
          id: 5,
          file: 'stickers/s.tgs',
          media_type: 'sticker',
          mime_type: 'application/x-tgsticker',
        }),
        msg({
          id: 6,
          file: 'voice_messages/a.ogg',
          media_type: 'voice_message',
          mime_type: 'audio/ogg',
        }),
        msg({ id: 7, file: 'files/doc.pdf', mime_type: 'application/pdf', ...text('a document') }),
        msg({ id: 8, photo: 'photos/ok.jpg' }),
        msg({ id: 9, photo: 'photos/missing.jpg' }),
      ],
      files,
    });
    const values = (await collect(src)).map((v) => v.value);
    expect(values[0]).toMatchObject({
      kind: 'post',
      text: 'with text',
      media: [],
      mediaSkipped: 1,
    });
    expect(values[1]).toMatchObject({ kind: 'skipped', reason: 'empty', mediaSkipped: 1 });
    expect(values[2]).toMatchObject({ media: [{ mimeType: 'video/mp4' }] });
    expect(values[3]).toMatchObject({ media: [{ mimeType: 'image/webp' }] });
    expect(values[4]).toMatchObject({ kind: 'skipped', reason: 'empty', mediaSkipped: 1 });
    expect(values[5]).toMatchObject({ kind: 'skipped', reason: 'empty', mediaSkipped: 1 });
    expect(values[6]).toMatchObject({ text: 'a document', media: [], mediaSkipped: 1 });
    expect(values[7]).toMatchObject({ media: [{ mimeType: 'image/jpeg' }] });
    expect(values[8]).toMatchObject({ kind: 'skipped', reason: 'empty', mediaSkipped: 1 });
  });

  test('media over the per-file cap is skipped and counted; readMedia serves the rest', async () => {
    const files = [jpg('big.jpg', 5000), jpg('small.jpg', 100)];
    const src = await source(
      {
        messages: [
          msg({ id: 1, photo: 'photos/big.jpg', ...text('big') }),
          msg({ id: 2, photo: 'photos/small.jpg' }),
        ],
        files,
      },
      1000,
    );
    const [big, small] = items(await collect(src));
    expect(big).toMatchObject({ media: [], mediaSkipped: 1 });
    const bytes = await src.readMedia(small.media[0].url, 10_000);
    expect(bytes?.contentType).toBe('image/jpeg');
    expect(bytes?.buffer.equals(Buffer.alloc(100, 1))).toBe(true);
    expect(await src.readMedia(small.media[0].url, 50)).toBeNull();
    expect(
      await src.readMedia(
        `${TELEGRAM_MEDIA_URL_PREFIX}${encodeURIComponent('photos/big.jpg')}`,
        1e6,
      ),
    ).toBeNull();
    expect(await src.readMedia('https://example.com/a.jpg', 1e6)).toBeNull();
  });

  test('polls, locations and contacts become a line of text', async () => {
    const src = await source({
      messages: [
        msg({
          id: 1,
          poll: {
            question: 'Tea or coffee?',
            closed: false,
            answers: [{ text: 'Tea' }, { text: 'Coffee' }],
          },
        }),
        msg({
          id: 2,
          location_information: { latitude: 41.39, longitude: 2.17 },
          place_name: 'A Square',
          address: '1 Example St',
        }),
        msg({
          id: 3,
          contact_information: {
            first_name: 'Ada',
            last_name: 'Example',
            phone_number: '+10000000000',
          },
        }),
        msg({ id: 4 }),
      ],
    });
    const values = (await collect(src)).map((v) => v.value);
    expect(values[0]).toMatchObject({ text: 'Poll: Tea or coffee?\n- Tea\n- Coffee' });
    expect(values[1]).toMatchObject({ text: 'Location: A Square, 1 Example St (41.39, 2.17)' });
    expect(values[2]).toMatchObject({ text: 'Contact: Ada Example, +10000000000' });
    expect(values[3]).toMatchObject({ kind: 'skipped', reason: 'empty' });
  });

  test('text entities and links reach the item', async () => {
    const src = await source({
      messages: [
        msg({
          id: 1,
          text_entities: [
            { type: 'bold', text: 'News' },
            { type: 'plain', text: ': ' },
            { type: 'text_link', text: 'the article', href: 'https://example.com/a' },
          ],
        }),
      ],
    });
    const [item] = items(await collect(src));
    expect(item.text).toBe('News: the article');
    expect(item.links).toEqual(['https://example.com/a']);
  });

  test('resume: no duplicates, and quotes still resolve across the cursor', async () => {
    const photos = [jpg('a.jpg'), jpg('b.jpg')];
    const messages = [
      msg({ id: 1, ...text('one') }),
      msg({ id: 2, unix: T0, photo: photos[0].path, ...text('album') }),
      msg({ id: 3, unix: T0, photo: photos[1].path }),
      msg({ id: 4, type: 'service', action: 'pin_message' }),
      msg({ id: 5, reply_to_message_id: 3, ...text('reply') }),
      msg({ id: 6, ...text('six') }),
    ];
    const src = await source({ messages, files: photos });
    const all = await collect(src);
    expect(all.map((v) => v.cursor.lastMessageId)).toEqual([1, 3, 4, 5, 6]);

    const resumed = await collect(src, {}, all[1].cursor);
    expect(resumed).toEqual(all.slice(2));
    expect(items(resumed)[0].quoteSourceId).toBe(`${CHANNEL_ID}/2`);
  });

  test('result.json at the archive root, and the shallowest one wins', async () => {
    const zip = await openZip(
      bufferRangeReader(
        await buildZip([
          {
            path: 'files/result.json',
            data: JSON.stringify({ name: 'Nested', type: 'personal_chat', id: 1, messages: [] }),
          },
          {
            path: 'result.json',
            data: JSON.stringify({
              name: 'Root',
              type: 'public_channel',
              id: 9,
              messages: [msg({ id: 1, ...text('hi') })],
            }),
          },
        ]),
      ),
    );
    const src = await openTelegramSource(zip);
    expect(src.header.name).toBe('Root');
    expect(items(await collect(src))[0].sourceUrl).toBe('https://t.me/c/9/1');
  });

  test('an HTML export is telegram_export_not_json', async () => {
    const zip = await openZip(
      bufferRangeReader(
        await buildZip([
          { path: `${FOLDER}messages.html`, data: '<html></html>' },
          { path: `${FOLDER}messages2.html`, data: '<html></html>' },
        ]),
      ),
    );
    expect((await exportError(openTelegramSource(zip))).code).toBe('telegram_export_not_json');
  });

  test('anything but a channel is telegram_export_unsupported_chat', async () => {
    for (const type of ['personal_chat', 'private_supergroup', 'public_supergroup', 'bot_chat']) {
      const zip = await exportZip({ header: { type }, messages: [] });
      expect((await exportError(openTelegramSource(zip))).code).toBe(
        'telegram_export_unsupported_chat',
      );
    }
    const wholeAccount = await openZip(
      bufferRangeReader(
        await buildZip([
          {
            path: 'DataExport/result.json',
            data: JSON.stringify({
              about: 'x',
              personal_information: { first_name: 'A' },
              chats: { list: [] },
            }),
          },
        ]),
      ),
    );
    expect((await exportError(openTelegramSource(wholeAccount))).code).toBe(
      'telegram_export_unsupported_chat',
    );
  });

  test('broken archives and broken JSON are telegram_export_invalid', async () => {
    const truncated = await openZip(
      bufferRangeReader(
        await buildZip([
          {
            path: 'result.json',
            data: `{"name":"x","type":"public_channel","id":1,"messages":[${JSON.stringify(msg({ id: 1, ...text('a') }))},{"id":2`,
          },
        ]),
      ),
    );
    const src = await openTelegramSource(truncated);
    expect((await exportError(collect(src))).code).toBe('telegram_export_invalid');

    // A result.json padded into a 100:1+ bomb is refused through the zip layer.
    const padded = `{"name":"x","type":"public_channel","id":1,"messages":[]${' '.repeat(3 * 1024 * 1024)}}`;
    const bomb = await openZip(
      bufferRangeReader(await buildZip([{ path: 'result.json', data: padded }])),
    );
    const error = await exportError(openTelegramSource(bomb));
    expect(error.code).toBe('telegram_export_invalid');
    expect(error.detail).toBe('zip_bomb');

    const empty = await openZip(bufferRangeReader(await buildZip([{ path: 'a.txt', data: 'x' }])));
    expect((await exportError(openTelegramSource(empty))).code).toBe('telegram_export_invalid');
  });

  test('a large result.json streams across many chunks in order', async () => {
    const messages = Array.from({ length: 5000 }, (_, i) =>
      msg({ id: i + 1, ...text(`post ${i + 1} ${'lorem ipsum '.repeat(20)}`) }),
    );
    const values = await collect(await source({ messages }));
    expect(values).toHaveLength(5000);
    expect(values.every((v, i) => v.cursor.lastMessageId === i + 1)).toBe(true);
  });
});
