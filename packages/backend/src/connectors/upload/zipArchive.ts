/**
 * A random-access zip reader over byte ranges, for an archive the user uploaded.
 *
 * The archive is never on local disk: production reads it with HTTP Range GETs
 * on a short-lived presigned URL, tests with an in-memory buffer. Both are a
 * {@link RangeReader}. yauzl does the zip parsing (zip64 included); this module
 * adds the reading strategy and the refusals:
 *
 * - Small reads (the end-of-central-directory search, each central-directory
 *   record, each local header) are served from a few cached 1 MiB blocks, so
 *   listing 250k entries costs ~20 range requests instead of 500k.
 * - Entry data is streamed in bounded chunks, never fetched whole, so a
 *   result.json of hundreds of MB inflates in constant memory.
 * - The archive is refused when it holds more than `maxEntries` entries, an
 *   encrypted entry, an absolute or `..` path, or the same path twice.
 * - An entry is refused when its declared size exceeds the caller's cap, when
 *   it is over 1 MiB and claims to inflate more than 100:1 (zip bomb), and when
 *   it inflates past its declared size (yauzl's byte-count check plus our own).
 */

import { Readable, Transform, type TransformCallback } from 'node:stream';
import yauzl from 'yauzl';

/** Byte-range access to an archive. `end` is EXCLUSIVE. */
export interface RangeReader {
  size: number;
  read(start: number, end: number): Promise<Buffer>;
}

export interface ZipLimits {
  /** Refuse an archive with more entries than this. Default 250 000. */
  maxEntries?: number;
  /** Refuse an entry inflating more than this ratio… Default 100. */
  maxCompressionRatio?: number;
  /** …once it is larger than this many bytes. Default 1 MiB. */
  ratioCheckAboveBytes?: number;
}

export interface ZipEntryInfo {
  /** Normalised path: `/`-separated, no leading `/`, never `..`. */
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  isDirectory: boolean;
}

export interface ZipArchive {
  entries(): ZipEntryInfo[];
  entry(path: string): ZipEntryInfo | undefined;
  /** A stream of the entry's inflated bytes; refuses entries over `maxBytes`. */
  openEntry(path: string, maxBytes: number): Promise<Readable>;
  readEntry(path: string, maxBytes: number): Promise<Buffer>;
  close(): void;
}

export type ZipArchiveErrorCode =
  | 'zip_invalid'
  | 'zip_too_many_entries'
  | 'zip_encrypted'
  | 'zip_unsafe_path'
  | 'zip_entry_not_found'
  | 'zip_entry_too_large'
  | 'zip_bomb'
  | 'zip_entry_size_mismatch';

export class ZipArchiveError extends Error {
  readonly code: ZipArchiveErrorCode;
  constructor(code: ZipArchiveErrorCode, message: string) {
    super(message);
    this.name = 'ZipArchiveError';
    this.code = code;
  }
}

export const DEFAULT_ZIP_LIMITS: Required<ZipLimits> = {
  maxEntries: 250_000,
  maxCompressionRatio: 100,
  ratioCheckAboveBytes: 1024 * 1024,
};

/**
 * A failure of the {@link RangeReader} itself (network, expired URL). It is
 * unwrapped back to the reader's own error, never reported as a bad archive:
 * a transient read failure must stay retryable.
 */
class RangeReadError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'RangeReadError';
  }
}

function readRange(source: RangeReader, start: number, end: number): Promise<Buffer> {
  return source.read(start, end).catch((error: unknown) => {
    throw new RangeReadError(error);
  });
}

const BLOCK_SIZE = 1024 * 1024;
const CACHED_BLOCKS = 4;
const STREAM_CHUNK = 1024 * 1024;

/** A {@link RangeReader} over a buffer: tests, and anything already in memory. */
export function bufferRangeReader(buffer: Buffer): RangeReader {
  return {
    size: buffer.length,
    async read(start, end) {
      return buffer.subarray(start, Math.min(end, buffer.length));
    },
  };
}

/** Bridges a {@link RangeReader} to yauzl: cached blocks for small reads, chunked streams for data. */
class RangeRandomAccessReader extends yauzl.RandomAccessReader {
  private readonly blocks = new Map<number, Promise<Buffer>>();

  constructor(private readonly source: RangeReader) {
    super();
  }

  private block(index: number): Promise<Buffer> {
    const cached = this.blocks.get(index);
    if (cached) {
      // Re-insert: Map order is the LRU order.
      this.blocks.delete(index);
      this.blocks.set(index, cached);
      return cached;
    }
    const start = index * BLOCK_SIZE;
    const loading = readRange(this.source, start, Math.min(start + BLOCK_SIZE, this.source.size));
    loading.catch(() => this.blocks.delete(index));
    this.blocks.set(index, loading);
    while (this.blocks.size > CACHED_BLOCKS) {
      const oldest = this.blocks.keys().next().value as number;
      this.blocks.delete(oldest);
    }
    return loading;
  }

  private async readCached(position: number, length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let at = position;
    const end = Math.min(position + length, this.source.size);
    while (at < end) {
      const index = Math.floor(at / BLOCK_SIZE);
      const block = await this.block(index);
      const offset = at - index * BLOCK_SIZE;
      const take = Math.min(block.length - offset, end - at);
      if (take <= 0) break;
      parts.push(block.subarray(offset, offset + take));
      at += take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null, bytesRead: number) => void,
  ): void {
    this.readCached(position, length).then(
      (bytes) => {
        bytes.copy(buffer, offset);
        callback(null, bytes.length);
      },
      (error: Error) => callback(error, 0),
    );
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const source = this.source;
    let at = start;
    return new Readable({
      highWaterMark: STREAM_CHUNK,
      read() {
        if (at >= end) {
          this.push(null);
          return;
        }
        const to = Math.min(at + STREAM_CHUNK, end);
        readRange(source, at, to).then(
          (chunk) => {
            if (chunk.length === 0) {
              this.destroy(new Error('unexpected end of archive'));
              return;
            }
            at += chunk.length;
            this.push(chunk);
          },
          (error: Error) => this.destroy(error),
        );
      },
    });
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * yauzl's own decoding, except that a name WITHOUT the UTF-8 flag that is valid
 * UTF-8 is read as UTF-8: macOS Archive Utility writes UTF-8 names and never
 * sets the flag, and CP437 would turn them into names result.json never uses.
 */
function decodeFileName(entry: yauzl.Entry): string {
  const raw = entry.fileNameRaw;
  const flagged = (entry.generalPurposeBitFlag & 0x800) !== 0;
  const unicodeExtra = entry.extraFields.some((field) => field.id === 0x7075);
  if (!flagged && !unicodeExtra) {
    try {
      return utf8.decode(raw).replace(/\\/g, '/');
    } catch {
      // Not UTF-8: fall through to CP437.
    }
  }
  return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, false);
}

/** The normalised path, or null when it is absolute, climbs out, or carries a NUL. */
export function safeArchivePath(name: string): string | null {
  if (name.includes('\0')) return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const segments = name.split('/');
  if (segments.includes('..')) return null;
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A {@link ZipArchiveError}, or — for a failed range read — the reader's own error. */
function asZipError(error: unknown): unknown {
  if (error instanceof ZipArchiveError) return error;
  if (error instanceof RangeReadError) return error.original;
  const message = errorMessage(error);
  if (/encrypt/i.test(message)) return new ZipArchiveError('zip_encrypted', message);
  if (/too many bytes|not enough bytes/.test(message))
    return new ZipArchiveError('zip_entry_size_mismatch', message);
  return new ZipArchiveError('zip_invalid', message);
}

/** Counts inflated bytes against the declared size: our own check on top of yauzl's. */
class ByteCap extends Transform {
  private seen = 0;
  constructor(private readonly cap: number) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.cap) {
      callback(
        new ZipArchiveError('zip_entry_size_mismatch', 'entry inflates past its declared size'),
      );
      return;
    }
    callback(null, chunk);
  }
}

function readCentralDirectory(zipfile: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zipfile.on('entry', (entry: yauzl.Entry) => {
      entries.push(entry);
      zipfile.readEntry();
    });
    zipfile.once('end', () => resolve(entries));
    zipfile.once('error', reject);
    zipfile.readEntry();
  });
}

/** Opens an archive and reads its whole central directory; refuses it on the rules above. */
export async function openZip(reader: RangeReader, limits: ZipLimits = {}): Promise<ZipArchive> {
  const { maxEntries, maxCompressionRatio, ratioCheckAboveBytes } = {
    ...DEFAULT_ZIP_LIMITS,
    ...limits,
  };
  let zipfile: yauzl.ZipFile;
  try {
    zipfile = await yauzl.fromRandomAccessReaderPromise(
      new RangeRandomAccessReader(reader),
      reader.size,
      { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true },
    );
  } catch (error) {
    throw asZipError(error);
  }
  if (zipfile.entryCount > maxEntries) {
    zipfile.close();
    throw new ZipArchiveError(
      'zip_too_many_entries',
      `the archive holds ${zipfile.entryCount} entries, over ${maxEntries}`,
    );
  }

  let raw: yauzl.Entry[];
  try {
    raw = await readCentralDirectory(zipfile);
  } catch (error) {
    zipfile.close();
    throw asZipError(error);
  }

  const byPath = new Map<string, { info: ZipEntryInfo; entry: yauzl.Entry }>();
  try {
    for (const entry of raw) {
      if (entry.isEncrypted())
        throw new ZipArchiveError('zip_encrypted', 'the archive holds an encrypted entry');
      const name = decodeFileName(entry);
      const path = safeArchivePath(name);
      if (path === null)
        throw new ZipArchiveError('zip_unsafe_path', `unsafe entry path: ${name.slice(0, 200)}`);
      if (path === '') continue;
      if (byPath.has(path))
        throw new ZipArchiveError('zip_invalid', `duplicate entry path: ${path.slice(0, 200)}`);
      byPath.set(path, {
        entry,
        info: {
          path,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          isDirectory: name.endsWith('/'),
        },
      });
    }
  } catch (error) {
    zipfile.close();
    throw error;
  }

  const lookup = (path: string, maxBytes: number) => {
    const found = byPath.get(path);
    if (!found || found.info.isDirectory)
      throw new ZipArchiveError('zip_entry_not_found', `no entry ${path.slice(0, 200)}`);
    const { uncompressedSize, compressedSize } = found.info;
    if (uncompressedSize > maxBytes) {
      throw new ZipArchiveError(
        'zip_entry_too_large',
        `entry is ${uncompressedSize} bytes, over ${maxBytes}`,
      );
    }
    if (
      uncompressedSize > ratioCheckAboveBytes &&
      uncompressedSize > Math.max(compressedSize, 1) * maxCompressionRatio
    ) {
      throw new ZipArchiveError(
        'zip_bomb',
        `entry claims ${uncompressedSize} bytes from ${compressedSize} (over ${maxCompressionRatio}:1)`,
      );
    }
    return found;
  };

  const openEntry = async (path: string, maxBytes: number): Promise<Readable> => {
    const { entry, info } = lookup(path, maxBytes);
    let stream: Readable;
    try {
      stream = await zipfile.openReadStreamPromise(entry);
    } catch (error) {
      throw asZipError(error);
    }
    const capped = new ByteCap(info.uncompressedSize);
    stream.on('error', (error) => {
      const translated = asZipError(error);
      capped.destroy(translated instanceof Error ? translated : new Error(String(translated)));
    });
    capped.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    return stream.pipe(capped);
  };

  return {
    entries: () => [...byPath.values()].map((value) => value.info),
    entry: (path) => byPath.get(path)?.info,
    openEntry,
    async readEntry(path, maxBytes) {
      const stream = await openEntry(path, maxBytes);
      // The stream's errors are already translated (see openEntry).
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    },
    close: () => zipfile.close(),
  };
}
