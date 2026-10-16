/**
 * Reading a Telegram Desktop JSON export out of the user's zip.
 *
 * The export is a folder (`ChatExport_<date>/`) holding `result.json` and the
 * media it points to (`photos/…`, `video_files/…`, `stickers/…`). Users zip the
 * folder itself or its contents, so `result.json` is found at the root or one
 * level down; the SHALLOWEST one wins (a deeper one is a file somebody posted).
 * Media paths in `result.json` are relative to its folder.
 *
 * `result.json` can be hundreds of MB, so it is never `JSON.parse`d: it is
 * inflated as a stream and fed to a streaming JSON parser that emits the
 * top-level `name`/`type`/`id` and then each element of `messages`, without
 * keeping the ones already emitted. Memory stays at one message plus one chunk.
 */

import { JSONParser } from '@streamparser/json';
import { ZipArchiveError, type ZipArchive } from '../upload/zipArchive';
import {
  telegramExportHeaderSchema,
  telegramMessageSchema,
  type TelegramExportHeader,
  type TelegramMessage,
} from './exportSchema';

export type TelegramExportErrorCode =
  | 'telegram_export_invalid'
  | 'telegram_export_not_json'
  | 'telegram_export_unsupported_chat';

export class TelegramExportError extends Error {
  readonly code: TelegramExportErrorCode;
  /** The archive-level reason (`zip_bomb`, `zip_unsafe_path`, …) when there is one. */
  readonly detail?: string;
  constructor(code: TelegramExportErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'TelegramExportError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A bad archive becomes `telegram_export_invalid`, keeping its zip code. Any
 * other error (the range read failed: network, expired URL) is returned as it
 * is, so it stays retryable.
 */
export function asTelegramExportError(error: unknown): unknown {
  if (error instanceof ZipArchiveError)
    return new TelegramExportError('telegram_export_invalid', error.message, error.code);
  return error;
}

/** Upper bound on the inflated result.json. It streams, so this only bounds the work. */
export const RESULT_JSON_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export interface TelegramExportLocation {
  /** Zip path of result.json. */
  resultPath: string;
  /** Its folder, `''` or ending in `/`; media paths are relative to it. */
  baseDir: string;
}

function depth(path: string): number {
  return path.split('/').length;
}

/** Finds result.json; an HTML export is `telegram_export_not_json`. */
export function locateTelegramExport(zip: ZipArchive): TelegramExportLocation {
  const files = zip.entries().filter((entry) => !entry.isDirectory);
  const candidates = files
    .filter((entry) => entry.path === 'result.json' || entry.path.endsWith('/result.json'))
    .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  const found = candidates[0];
  if (found) {
    return {
      resultPath: found.path,
      baseDir: found.path.slice(0, found.path.length - 'result.json'.length),
    };
  }
  const html = files.some((entry) => /(^|\/)messages\d*\.html$/.test(entry.path));
  if (html) {
    throw new TelegramExportError(
      'telegram_export_not_json',
      'this is an HTML export; export again choosing "Machine-readable JSON"',
    );
  }
  throw new TelegramExportError('telegram_export_invalid', 'no result.json in the archive');
}

/**
 * The placeholder Telegram writes instead of a path when a file was left out:
 * `(File not included. Change data exporting settings to download.)`,
 * `(File exceeds maximum size. Change data exporting settings to download.)`.
 */
export function isMediaPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^\(.*\)$/s.test(trimmed) ||
    /file not included|exceeds maximum size/i.test(trimmed) ||
    trimmed === ''
  );
}

/**
 * The zip path a result.json media reference names, or null when it is a
 * placeholder, climbs out of the export folder, or is not in the archive.
 */
export function resolveExportMediaPath(
  zip: ZipArchive,
  location: TelegramExportLocation,
  relative: string | undefined,
): string | null {
  if (typeof relative !== 'string' || isMediaPlaceholder(relative)) return null;
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  const path = `${location.baseDir}${segments.join('/')}`;
  const entry = zip.entry(path);
  return entry && !entry.isDirectory ? path : null;
}

export type TelegramExportEvent =
  | { kind: 'header'; header: TelegramExportHeader }
  | { kind: 'message'; message: TelegramMessage }
  /** An element of `messages` that failed the schema; `id` when it had one. */
  | { kind: 'malformed'; id?: number };

const HEADER_KEYS = new Set(['name', 'type', 'id']);

function parseHeader(partial: Record<string, unknown>): TelegramExportHeader {
  const parsed = telegramExportHeaderSchema.safeParse(partial);
  if (!parsed.success) {
    throw new TelegramExportError(
      'telegram_export_invalid',
      'result.json is not a single-chat export (no name, type and id before its messages)',
    );
  }
  return parsed.data;
}

/**
 * Streams result.json: one `header` event, then every message in export order
 * (oldest first). The archive stream is closed when the consumer stops early.
 */
export async function* readTelegramExport(
  zip: ZipArchive,
  location: TelegramExportLocation,
  options: { maxBytes?: number } = {},
): AsyncGenerator<TelegramExportEvent> {
  let stream: Awaited<ReturnType<ZipArchive['openEntry']>>;
  try {
    stream = await zip.openEntry(location.resultPath, options.maxBytes ?? RESULT_JSON_MAX_BYTES);
  } catch (error) {
    throw asTelegramExportError(error);
  }

  const parser = new JSONParser({
    paths: ['$.name', '$.type', '$.id', '$.personal_information', '$.messages.*'],
    keepStack: false,
  });
  const partialHeader: Record<string, unknown> = {};
  const queue: TelegramExportEvent[] = [];
  let headerSent = false;
  let ended = false;
  let failure: TelegramExportError | null = null;

  const sendHeader = () => {
    if (headerSent) return;
    headerSent = true;
    queue.push({ kind: 'header', header: parseHeader(partialHeader) });
  };

  parser.onValue = ({ value, key, stack }) => {
    if (failure) return;
    try {
      if (stack.length === 1) {
        if (key === 'personal_information') {
          throw new TelegramExportError(
            'telegram_export_unsupported_chat',
            'this is a whole-account export; export one channel ("Export chat history")',
          );
        }
        if (typeof key === 'string' && HEADER_KEYS.has(key)) partialHeader[key] = value;
        return;
      }
      sendHeader();
      const parsed = telegramMessageSchema.safeParse(value);
      if (parsed.success) {
        queue.push({ kind: 'message', message: parsed.data });
      } else {
        const id = (value as { id?: unknown } | null)?.id;
        queue.push({ kind: 'malformed', ...(typeof id === 'number' ? { id } : {}) });
      }
    } catch (error) {
      failure =
        error instanceof TelegramExportError
          ? error
          : new TelegramExportError('telegram_export_invalid', String(error));
    }
  };
  parser.onError = (error) => {
    failure ??= new TelegramExportError(
      'telegram_export_invalid',
      `result.json is not valid JSON: ${error.message}`,
    );
  };
  parser.onEnd = () => {
    ended = true;
  };

  try {
    for await (const chunk of stream) {
      if (!ended) parser.write(chunk as Buffer);
      if (failure) throw failure;
      for (const event of queue.splice(0)) yield event;
    }
    if (!ended) {
      throw new TelegramExportError('telegram_export_invalid', 'result.json ends mid-document');
    }
    sendHeader();
    for (const event of queue.splice(0)) yield event;
  } catch (error) {
    throw asTelegramExportError(error);
  } finally {
    stream.destroy();
  }
}
