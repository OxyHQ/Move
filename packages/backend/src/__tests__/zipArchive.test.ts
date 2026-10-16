import { describe, expect, test } from 'bun:test';
import {
  ZipArchiveError,
  bufferRangeReader,
  openZip,
  type RangeReader,
} from '../connectors/upload/zipArchive';
import {
  buildZip,
  forgeUncompressedSize,
  forgeZip64EntryCount,
  markEncrypted,
  replaceBytes,
} from './helpers/zipFixture';

async function zipError(promise: Promise<unknown>): Promise<ZipArchiveError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ZipArchiveError) return error;
    throw error;
  }
  throw new Error('expected a ZipArchiveError');
}

function countingReader(buffer: Buffer): RangeReader & { calls: number } {
  const inner = bufferRangeReader(buffer);
  const reader = {
    size: inner.size,
    calls: 0,
    read(start: number, end: number) {
      reader.calls++;
      return inner.read(start, end);
    },
  };
  return reader;
}

describe('openZip', () => {
  test('lists entries and reads deflated and stored ones', async () => {
    const zip = await openZip(
      bufferRangeReader(
        await buildZip([
          { path: 'Export/result.json', data: '{"a":1}' },
          { path: 'Export/photos/p.jpg', data: Buffer.alloc(3000, 7), compress: false },
        ]),
      ),
    );
    expect(zip.entries().map((entry) => entry.path)).toEqual([
      'Export/result.json',
      'Export/photos/p.jpg',
    ]);
    expect((await zip.readEntry('Export/result.json', 100)).toString()).toBe('{"a":1}');
    expect((await zip.readEntry('Export/photos/p.jpg', 3000)).equals(Buffer.alloc(3000, 7))).toBe(
      true,
    );
    expect((await zipError(zip.readEntry('nope', 10))).code).toBe('zip_entry_not_found');
    expect((await zipError(zip.readEntry('Export/photos/p.jpg', 2999))).code).toBe(
      'zip_entry_too_large',
    );
  });

  test('reads zip64 archives', async () => {
    const zip = await openZip(
      bufferRangeReader(
        await buildZip(
          [
            { path: 'a.txt', data: 'hello', zip64: true },
            { path: 'b.txt', data: 'world', zip64: true, compress: false },
          ],
          { zip64: true },
        ),
      ),
    );
    expect((await zip.readEntry('a.txt', 10)).toString()).toBe('hello');
    expect((await zip.readEntry('b.txt', 10)).toString()).toBe('world');
  });

  test('lists a large central directory in a handful of range reads', async () => {
    const files = Array.from({ length: 3000 }, (_, i) => ({
      path: `Export/photos/photo_${i}.jpg`,
      data: `x${i}`,
    }));
    const reader = countingReader(await buildZip(files));
    const zip = await openZip(reader);
    expect(zip.entries()).toHaveLength(3000);
    expect(reader.calls).toBeLessThan(5);
  });

  test('refuses too many entries, before reading them', async () => {
    const small = await buildZip([
      { path: 'a', data: '1' },
      { path: 'b', data: '2' },
      { path: 'c', data: '3' },
    ]);
    expect((await zipError(openZip(bufferRangeReader(small), { maxEntries: 2 }))).code).toBe(
      'zip_too_many_entries',
    );
    // The default limit (250k), against a zip64 record claiming 300k entries.
    const forged = forgeZip64EntryCount(
      await buildZip([{ path: 'a', data: '1', zip64: true }], { zip64: true }),
      300_000,
    );
    expect((await zipError(openZip(bufferRangeReader(forged)))).code).toBe('zip_too_many_entries');
  });

  test('refuses encrypted entries', async () => {
    const zip = markEncrypted(await buildZip([{ path: 'a.txt', data: 'secret' }]));
    expect((await zipError(openZip(bufferRangeReader(zip)))).code).toBe('zip_encrypted');
  });

  test('refuses paths that climb out or are absolute', async () => {
    const climbing = replaceBytes(
      await buildZip([{ path: 'aa/evil.txt', data: 'x' }]),
      'aa/evil',
      '../evil',
    );
    expect((await zipError(openZip(bufferRangeReader(climbing)))).code).toBe('zip_unsafe_path');
    const absolute = replaceBytes(
      await buildZip([{ path: 'aetc/passwd', data: 'x' }]),
      'aetc/passwd',
      '/etc/passwd',
    );
    expect((await zipError(openZip(bufferRangeReader(absolute)))).code).toBe('zip_unsafe_path');
  });

  test('refuses an entry over 1 MiB that claims more than 100:1', async () => {
    const zip = await openZip(
      bufferRangeReader(
        await buildZip([
          { path: 'bomb.json', data: Buffer.alloc(4 * 1024 * 1024, 0x20) },
          { path: 'small.json', data: Buffer.alloc(512 * 1024, 0x20) },
        ]),
      ),
    );
    expect((await zipError(zip.readEntry('bomb.json', 10 * 1024 * 1024))).code).toBe('zip_bomb');
    // Under 1 MiB the ratio is not checked.
    expect((await zip.readEntry('small.json', 1024 * 1024)).length).toBe(512 * 1024);
  });

  test('refuses an entry inflating past its declared size', async () => {
    const forged = forgeUncompressedSize(
      await buildZip([{ path: 'a.txt', data: 'abcdefghij'.repeat(500) }]),
      4000,
    );
    const zip = await openZip(bufferRangeReader(forged));
    expect((await zipError(zip.readEntry('a.txt', 10_000))).code).toBe('zip_entry_size_mismatch');
  });

  test('a garbage file is zip_invalid', async () => {
    const garbage = Buffer.from('this is not a zip archive at all, just text');
    expect((await zipError(openZip(bufferRangeReader(garbage)))).code).toBe('zip_invalid');
  });

  test('a failing range read surfaces as the reader error, never as a bad archive', async () => {
    const buffer = await buildZip([{ path: 'a.txt', data: 'abcdefghij'.repeat(500) }]);
    const outage = new Error('presigned URL expired');
    let broken = false;
    const flaky: RangeReader = {
      size: buffer.length,
      async read(start, end) {
        if (broken) throw outage;
        return buffer.subarray(start, end);
      },
    };
    const flakyZip = await openZip(flaky);
    broken = true;
    await expect(flakyZip.readEntry('a.txt', 10_000)).rejects.toBe(outage);
  });
});
