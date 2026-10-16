/**
 * A Telegram channel, read from the Telegram Desktop JSON export the user
 * uploaded as a zip (see `docs/telegram-import.md`).
 *
 * Unlike the other sources nothing is fetched from Telegram: the archive is
 * read by byte ranges ({@link ZipArchive}), `result.json` is streamed, and each
 * media file is served from the archive by {@link TelegramSource.readMedia}
 * under a `telegram-export:` URL this source mints.
 *
 * NOT WIRED YET: `telegram` is not a `MigrationPlatform`, so this class
 * implements the {@link Source} contract minus the platform type
 * ({@link TelegramSourceContract}). The wiring change widens the tuple and
 * switches it to `implements Source`.
 *
 * Ids: `sourceId` is `<channelId>/<messageId>` and `sourceUrl` is
 * `https://t.me/c/<channelId>/<messageId>`, the channel id without Telegram's
 * `-100` prefix. Mention's operator one-shot import keys items the same way, so
 * a Move import of a channel it already imported dedupes against it.
 */

import { config } from '../config';
import type { TelegramExportHeader, TelegramMessage } from '../connectors/telegram/exportSchema';
import {
  TelegramExportError,
  asTelegramExportError,
  locateTelegramExport,
  readTelegramExport,
  resolveExportMediaPath,
  type TelegramExportLocation,
} from '../connectors/telegram/exportReader';
import { renderTelegramText } from '../connectors/telegram/textEntities';
import { ZipArchiveError, type ZipArchive } from '../connectors/upload/zipArchive';
import type {
  GraphAccount,
  Positioned,
  SkippedItem,
  Source,
  SourceItem,
  SourceMedia,
  SourceMediaBytes,
  SourceProfile,
  SourceReadContext,
  SourceVisibility,
} from './types';

export interface TelegramCursor {
  /** The LAST message of the last value yielded (an album's last member). */
  lastMessageId: number;
}

/** {@link Source} for a platform the shared tuple does not list yet. */
export type TelegramSourceContract = Omit<Source<TelegramCursor, never>, 'platform'> & {
  readonly platform: 'telegram';
};

export const TELEGRAM_MEDIA_URL_PREFIX = 'telegram-export:';
/** Oxy's `/assets/service/user-media` refuses anything larger. */
export const OXY_USER_MEDIA_MAX_BYTES = 40 * 1024 * 1024;
export const TELEGRAM_ALBUM_MAX_MEDIA = 10;

const SUPPORTED_CHAT_TYPES = new Set(['public_channel', 'private_channel']);
/** Media kinds that are never part of an album. */
const SINGLE_MEDIA_TYPES = new Set(['sticker', 'voice_message', 'video_message']);
const VIDEO_MEDIA_TYPES = new Set(['video_file', 'animation', 'video_message']);

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export interface TelegramSourceOptions {
  /** Per-file cap. Default: min(`MEDIA_MAX_BYTES`, Oxy's 40 MiB user-media limit). */
  mediaMaxBytes?: number;
}

/** The channel id as Telegram's `t.me/c/` links spell it: no `-100` prefix. */
export function telegramChannelId(id: TelegramExportHeader['id']): string {
  const bare = String(id).replace(/^-100/, '');
  if (!/^\d+$/.test(bare)) {
    throw new TelegramExportError('telegram_export_invalid', `unexpected chat id ${String(id)}`);
  }
  return bare;
}

function unixMillis(message: TelegramMessage): number | null {
  if (message.date_unixtime === undefined) return null;
  const seconds = Number(message.date_unixtime);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function isForwarded(message: TelegramMessage): boolean {
  return message.forwarded_from !== undefined;
}

function isAlbumMember(message: TelegramMessage): boolean {
  if (message.type !== 'message') return false;
  if (message.photo !== undefined) return true;
  return message.file !== undefined && !SINGLE_MEDIA_TYPES.has(message.media_type ?? '');
}

function canJoin(album: TelegramMessage[], message: TelegramMessage): boolean {
  const head = album[0];
  return (
    album.length < TELEGRAM_ALBUM_MAX_MEDIA &&
    isAlbumMember(head) &&
    isAlbumMember(message) &&
    message.date_unixtime !== undefined &&
    String(message.date_unixtime) === String(head.date_unixtime) &&
    isForwarded(message) === isForwarded(head)
  );
}

/** What the message's media is, before it is looked up in the archive. */
function mediaCandidate(
  message: TelegramMessage,
): { path: string; mimeType: string } | 'drop' | null {
  if (message.photo !== undefined) return { path: message.photo, mimeType: 'image/jpeg' };
  if (message.file === undefined) return null;
  const mediaType = message.media_type ?? '';
  if (mediaType === 'sticker') {
    return /\.webp$/i.test(message.file) ? { path: message.file, mimeType: 'image/webp' } : 'drop';
  }
  if (VIDEO_MEDIA_TYPES.has(mediaType)) {
    const mime = message.mime_type?.toLowerCase() ?? 'video/mp4';
    return /^video\/|^image\/gif$/.test(mime) ? { path: message.file, mimeType: mime } : 'drop';
  }
  // Voice, audio, documents: nothing Mention can show.
  return 'drop';
}

function pollText(message: TelegramMessage): string {
  const poll = message.poll;
  if (!poll?.question?.trim()) return '';
  const answers = (poll.answers ?? [])
    .map((answer) => answer.text?.trim())
    .filter((text): text is string => Boolean(text))
    .map((text) => `- ${text}`);
  return [`Poll: ${poll.question.trim()}`, ...answers].join('\n');
}

function locationText(message: TelegramMessage): string {
  const location = message.location_information;
  const place = [message.place_name, message.address]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
  const coordinates =
    typeof location?.latitude === 'number' && typeof location.longitude === 'number'
      ? `${location.latitude}, ${location.longitude}`
      : '';
  if (place && coordinates) return `Location: ${place} (${coordinates})`;
  if (place || coordinates) return `Location: ${place || coordinates}`;
  return '';
}

function contactText(message: TelegramMessage): string {
  const contact = message.contact_information;
  if (!contact) return '';
  const name = [contact.first_name, contact.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
  const phone = contact.phone_number?.trim();
  const line = [name, phone].filter(Boolean).join(', ');
  return line ? `Contact: ${line}` : '';
}

/** Opens the export in the archive and checks it is a channel; the factory for {@link TelegramSource}. */
export async function openTelegramSource(
  zip: ZipArchive,
  options: TelegramSourceOptions = {},
): Promise<TelegramSource> {
  const location = locateTelegramExport(zip);
  let header: TelegramExportHeader | null = null;
  for await (const event of readTelegramExport(zip, location)) {
    if (event.kind === 'header') header = event.header;
    break;
  }
  if (!header) throw new TelegramExportError('telegram_export_invalid', 'result.json is empty');
  if (!SUPPORTED_CHAT_TYPES.has(header.type)) {
    throw new TelegramExportError(
      'telegram_export_unsupported_chat',
      `only channels can be imported, not a ${header.type}`,
    );
  }
  return new TelegramSource(zip, location, header, options);
}

type Value = Positioned<SourceItem | SkippedItem, TelegramCursor>;

export class TelegramSource implements TelegramSourceContract {
  readonly platform = 'telegram' as const;
  readonly channelId: string;
  private readonly mediaMaxBytes: number;
  private readonly visibility: SourceVisibility;

  constructor(
    private readonly zip: ZipArchive,
    private readonly location: TelegramExportLocation,
    readonly header: TelegramExportHeader,
    options: TelegramSourceOptions = {},
  ) {
    this.channelId = telegramChannelId(header.id);
    this.mediaMaxBytes = Math.min(
      options.mediaMaxBytes ?? config.media.maxBytes,
      OXY_USER_MEDIA_MAX_BYTES,
    );
    this.visibility = header.type === 'public_channel' ? 'public' : 'followers';
  }

  /** `<channelId>/<messageId>`: the ledger key Mention's one-shot uses too. */
  sourceIdOf(messageId: number): string {
    return `${this.channelId}/${messageId}`;
  }

  permalinkOf(messageId: number): string {
    return `https://t.me/c/${this.channelId}/${messageId}`;
  }

  async profile(): Promise<SourceProfile> {
    return {
      actor: `tg:${this.channelId}`,
      handle: this.header.name,
      displayName: this.header.name,
    };
  }

  graph(): AsyncIterable<Positioned<GraphAccount, never>> {
    // A channel export carries no follow list.
    return {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    };
  }

  /**
   * Every message, oldest first, an album folded into one item. A resume
   * re-streams the export from the start, rebuilding the album and import maps
   * the quotes need, and yields only what comes after the cursor.
   */
  async *items(context: SourceReadContext<TelegramCursor>): AsyncIterable<Value> {
    const resumeAfter = context.cursor?.lastMessageId ?? null;
    for await (const value of this.walk(context.options.includeBoosts)) {
      if (resumeAfter !== null && value.cursor.lastMessageId <= resumeAfter) continue;
      yield value;
    }
  }

  async readMedia(url: string, maxBytes: number): Promise<SourceMediaBytes | null> {
    if (!url.startsWith(TELEGRAM_MEDIA_URL_PREFIX)) return null;
    let path: string;
    try {
      path = decodeURIComponent(url.slice(TELEGRAM_MEDIA_URL_PREFIX.length));
    } catch {
      return null;
    }
    if (!path.startsWith(this.location.baseDir)) return null;
    const entry = this.zip.entry(path);
    const cap = Math.min(maxBytes, this.mediaMaxBytes);
    if (!entry || entry.isDirectory || entry.uncompressedSize > cap) return null;
    try {
      const buffer = await this.zip.readEntry(path, cap);
      const extension = path.split('.').pop()?.toLowerCase() ?? '';
      return { buffer, contentType: CONTENT_TYPES[extension] ?? '' };
    } catch (error) {
      // A bad entry can never be copied; a failed range read is retried by the job.
      if (error instanceof ZipArchiveError) return null;
      throw error;
    }
  }

  /** A reply's peer: absent means this chat; Telegram spells it `channel<id>` or a number. */
  private isSameChat(peer: TelegramMessage['reply_to_peer_id']): boolean {
    if (peer === undefined) return true;
    const raw = String(peer);
    const bare = raw.startsWith('-100') ? raw.slice(4) : raw.replace(/^[a-z_]+/i, '');
    return bare === this.channelId;
  }

  private async *walk(includeBoosts: boolean): AsyncGenerator<Value> {
    /** Album member id → album head id, for members only. */
    const albumHead = new Map<number, number>();
    /** Head ids yielded as items: only those can be quoted. */
    const imported = new Set<number>();
    let album: TelegramMessage[] = [];

    const flush = (): Value | null => {
      if (album.length === 0) return null;
      const members = album;
      album = [];
      const headId = members[0].id;
      for (const member of members.slice(1)) albumHead.set(member.id, headId);
      const value = this.build(members, includeBoosts, albumHead, imported);
      if (value.kind !== 'skipped') imported.add(headId);
      return { value, cursor: { lastMessageId: members[members.length - 1].id } };
    };

    const skip = (id: number, reason: SkippedItem['reason']): Value => ({
      value: { kind: 'skipped', sourceId: this.sourceIdOf(id), reason },
      cursor: { lastMessageId: id },
    });

    try {
      for await (const event of readTelegramExport(this.zip, this.location)) {
        if (event.kind === 'header') continue;
        if (event.kind === 'malformed') {
          const done = flush();
          if (done) yield done;
          if (event.id !== undefined) yield skip(event.id, 'unsupported');
          continue;
        }
        const message = event.message;
        if (album.length > 0 && canJoin(album, message)) {
          album.push(message);
          continue;
        }
        const done = flush();
        if (done) yield done;
        if (message.type !== 'message') {
          yield skip(message.id, 'unsupported');
          continue;
        }
        album = [message];
      }
      const done = flush();
      if (done) yield done;
    } catch (error) {
      throw asTelegramExportError(error);
    }
  }

  private build(
    members: TelegramMessage[],
    includeBoosts: boolean,
    albumHead: Map<number, number>,
    imported: Set<number>,
  ): SourceItem | SkippedItem {
    const head = members[0];
    const sourceId = this.sourceIdOf(head.id);

    const media: SourceMedia[] = [];
    let mediaSkipped = 0;
    for (const member of members) {
      const candidate = mediaCandidate(member);
      if (candidate === null) continue;
      const path =
        candidate === 'drop'
          ? null
          : resolveExportMediaPath(this.zip, this.location, candidate.path);
      const entry = path ? this.zip.entry(path) : undefined;
      if (candidate === 'drop' || !path || !entry || entry.uncompressedSize > this.mediaMaxBytes) {
        mediaSkipped++;
        continue;
      }
      media.push({
        url: `${TELEGRAM_MEDIA_URL_PREFIX}${encodeURIComponent(path)}`,
        mimeType: candidate.mimeType,
      });
    }
    const counted = mediaSkipped > 0 ? { mediaSkipped } : {};

    if (isForwarded(head) && !includeBoosts) {
      return { kind: 'skipped', sourceId, reason: 'boost-disabled', ...counted };
    }
    const createdAt = unixMillis(head);
    if (createdAt === null) return { kind: 'skipped', sourceId, reason: 'unsupported', ...counted };

    const rendered = members
      .map((member) => renderTelegramText(member))
      .find((candidate) => candidate.text.trim() !== '') ?? { text: '', links: [] };
    const body = [rendered.text, pollText(head), locationText(head), contactText(head)]
      .filter((part) => part !== '')
      .join('\n\n');
    if (body === '' && media.length === 0) {
      return { kind: 'skipped', sourceId, reason: 'empty', ...counted };
    }
    const text = isForwarded(head)
      ? `Forwarded from ${head.forwarded_from?.trim() || 'a hidden account'}:\n\n${body}`.trimEnd()
      : body;

    const item: SourceItem = {
      kind: 'post',
      sourceId,
      sourceUrl: this.permalinkOf(head.id),
      createdAt: new Date(createdAt).toISOString(),
      text,
      visibility: this.visibility,
      media,
      ...(rendered.links.length > 0 ? { links: rendered.links } : {}),
      ...counted,
    };

    const replyTo = members.find((member) => member.reply_to_message_id !== undefined);
    if (replyTo?.reply_to_message_id !== undefined && this.isSameChat(replyTo.reply_to_peer_id)) {
      const target = albumHead.get(replyTo.reply_to_message_id) ?? replyTo.reply_to_message_id;
      if (imported.has(target)) item.quoteSourceId = this.sourceIdOf(target);
    }
    return item;
  }
}
