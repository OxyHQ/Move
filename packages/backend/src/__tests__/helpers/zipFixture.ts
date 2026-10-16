/**
 * Builds zip archives in memory for the upload tests — synthetic content only,
 * never a real export — and the byte surgery the refusal tests need (a flag
 * flipped, a size forged, a name rewritten), which no honest writer produces.
 */

import yazl from 'yazl';

export interface ZipFile {
  path: string;
  data: Buffer | string;
  /** Deflate (default) or store. */
  compress?: boolean;
  zip64?: boolean;
}

/** `zip64`: also write the zip64 end-of-central-directory records. */
export async function buildZip(
  files: ZipFile[],
  options: { zip64?: boolean } = {},
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const file of files) {
    zip.addBuffer(Buffer.from(file.data), file.path, {
      compress: file.compress ?? true,
      forceZip64Format: file.zip64 ?? false,
      mtime: new Date('2024-01-01T00:00:00Z'),
    });
  }
  zip.end({ forceZip64Format: options.zip64 ?? false, comment: '' });
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const ZIP64_EOCD = 0x06064b50;

function offsetsOf(buffer: Buffer, signature: number): number[] {
  const found: number[] = [];
  for (let at = 0; at + 4 <= buffer.length; at++) {
    if (buffer.readUInt32LE(at) === signature) found.push(at);
  }
  return found;
}

/** Sets the "encrypted" general-purpose bit on every entry. */
export function markEncrypted(zip: Buffer): Buffer {
  const out = Buffer.from(zip);
  for (const at of offsetsOf(out, LOCAL_HEADER))
    out.writeUInt16LE(out.readUInt16LE(at + 6) | 1, at + 6);
  for (const at of offsetsOf(out, CENTRAL_HEADER))
    out.writeUInt16LE(out.readUInt16LE(at + 8) | 1, at + 8);
  return out;
}

/** Rewrites a byte string everywhere (a file name in both headers); same length only. */
export function replaceBytes(zip: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('replacement must keep the length');
  return Buffer.from(zip.toString('latin1').split(from).join(to), 'latin1');
}

/** Forges the central directory's declared uncompressed size of the first entry. */
export function forgeUncompressedSize(zip: Buffer, size: number): Buffer {
  const out = Buffer.from(zip);
  const [central] = offsetsOf(out, CENTRAL_HEADER);
  out.writeUInt32LE(size, central + 24);
  return out;
}

/** Forges the zip64 end-of-central-directory entry counts. */
export function forgeZip64EntryCount(zip: Buffer, count: number): Buffer {
  const out = Buffer.from(zip);
  const [record] = offsetsOf(out, ZIP64_EOCD);
  if (record === undefined) throw new Error('no zip64 end of central directory record');
  out.writeBigUInt64LE(BigInt(count), record + 24);
  out.writeBigUInt64LE(BigInt(count), record + 32);
  return out;
}
