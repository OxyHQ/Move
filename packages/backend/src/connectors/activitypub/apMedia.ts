// Provenance: copied from OxyHQ/Mention packages/backend/src/connectors/activitypub/apMedia.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). `resolveApAttachment`'s
// candidate ranking is unchanged; the output differs, because Move COPIES the
// bytes into Oxy rather than displaying a remote URL: it returns the MIME type
// with the href, and it refuses HLS/DASH manifests outright (a playlist is not
// a file that can be uploaded). Audio is dropped here, not after a download:
// Mention imports images and video only. Mention's `MediaMetadataService` merge is gone.

import type { SourceMedia } from '../../sources/types';

/** A single AP `Link` object as it appears inside `attachment[].url`. */
interface ApUrlEntry {
  type?: string;
  href?: string;
  mediaType?: string;
}

/** A single entry of an AP Note's `attachment` array. */
interface ApAttachment {
  type?: string;
  mediaType?: string;
  /** Accessibility text on Mastodon/Pleroma attachments. */
  name?: string;
  width?: number;
  height?: number;
  duration?: number | string;
  /** String (Mastodon), Link object (Pleroma), or array of Link objects (PeerTube). */
  url?: string | ApUrlEntry | Array<string | ApUrlEntry>;
}

type ApMediaType = 'image' | 'video';

interface ResolvedUrl {
  href: string;
  mimeType: string;
}

const VIDEO_EXTENSION_RE = /\.(mp4|mov|m4v|webm|mpg|mpeg|avi|mkv)(?:[?#].*)?$/i;
const IMAGE_EXTENSION_RE = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?)(?:[?#].*)?$/i;
const STREAMING_RE = /\.(m3u8|mpd)(?:[?#].*)?$/i;
const PROGRESSIVE_VIDEO_MIME = 'video/mp4';

const STREAMING_VIDEO_MIMES = new Set([
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
]);

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

function toResolvedUrl(member: string | ApUrlEntry | undefined, attachmentMimeType: string): ResolvedUrl | null {
  if (typeof member === 'string') {
    const href = member.trim();
    if (!href) return null;
    return { href, mimeType: attachmentMimeType };
  }
  if (member && typeof member === 'object') {
    const href = typeof member.href === 'string' ? member.href.trim() : '';
    if (!href) return null;
    const mimeType = (member.mediaType || attachmentMimeType || '').toLowerCase();
    return { href, mimeType };
  }
  return null;
}

function normalizeMime(mimeType: string): string {
  return mimeType.trim().toLowerCase();
}

function isStreaming(resolved: ResolvedUrl): boolean {
  return STREAMING_VIDEO_MIMES.has(normalizeMime(resolved.mimeType)) || STREAMING_RE.test(resolved.href);
}

function classify(resolved: ResolvedUrl): ApMediaType | null {
  if (isStreaming(resolved)) return null;
  const mime = normalizeMime(resolved.mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return null;
  if (VIDEO_EXTENSION_RE.test(resolved.href)) return 'video';
  if (IMAGE_EXTENSION_RE.test(resolved.href)) return 'image';
  return null;
}

function classifyFromApType(attachment: ApAttachment): ApMediaType | null {
  switch (attachment.type) {
    case 'Image':
      return 'image';
    case 'Video':
      return 'video';
    case 'Document': {
      const hasDuration = attachment.duration !== undefined && attachment.duration !== null;
      const width = typeof attachment.width === 'number' ? attachment.width : 0;
      const height = typeof attachment.height === 'number' ? attachment.height : 0;
      return !hasDuration && (width > 0 || height > 0) ? 'image' : null;
    }
    default:
      return null;
  }
}

function videoPreferenceScore(resolved: ResolvedUrl): number {
  const mime = normalizeMime(resolved.mimeType);
  if (mime === PROGRESSIVE_VIDEO_MIME) return 0;
  if (mime.startsWith('video/')) return 1;
  if (/\.mp4(?:[?#].*)?$/i.test(resolved.href)) return 0;
  if (VIDEO_EXTENSION_RE.test(resolved.href)) return 1;
  return 3;
}

/** Best-effort MIME when the attachment declared none: extension, then AP type. */
function inferMime(resolved: ResolvedUrl, kind: ApMediaType): string {
  const declared = normalizeMime(resolved.mimeType);
  if (declared) return declared;
  const extension = resolved.href.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
  if (extension && EXTENSION_MIME[extension]) return EXTENSION_MIME[extension];
  return kind === 'image' ? 'image/jpeg' : 'video/mp4';
}

/**
 * Resolve one attachment to the single most broadly playable, UPLOADABLE file.
 * Never throws: malformed entries resolve to `null`.
 */
function resolveApAttachment(
  attachment: ApAttachment | null | undefined,
): { href: string; type: ApMediaType; mimeType: string } | null {
  if (!attachment || typeof attachment !== 'object') return null;
  if (attachment.url === undefined || attachment.url === null) return null;

  const attachmentMime = normalizeMime(attachment.mediaType || '');
  const members: Array<string | ApUrlEntry> = Array.isArray(attachment.url) ? attachment.url : [attachment.url];

  const resolved: ResolvedUrl[] = [];
  for (const member of members) {
    const r = toResolvedUrl(member, attachmentMime);
    if (r) resolved.push(r);
  }
  if (resolved.length === 0) return null;

  const videos: ResolvedUrl[] = [];
  const images: ResolvedUrl[] = [];
  for (const r of resolved) {
    const kind = classify(r);
    if (kind === 'video') videos.push(r);
    else if (kind === 'image') images.push(r);
  }

  if (videos.length > 0) {
    const best = videos.reduce((a, b) => (videoPreferenceScore(b) < videoPreferenceScore(a) ? b : a));
    return { href: best.href, type: 'video', mimeType: inferMime(best, 'video') };
  }
  if (images.length > 0) return { href: images[0].href, type: 'image', mimeType: inferMime(images[0], 'image') };

  const undeclared = resolved.find((r) => normalizeMime(r.mimeType).length === 0 && !isStreaming(r));
  if (undeclared) {
    const apType = classifyFromApType(attachment);
    if (apType) return { href: undeclared.href, type: apType, mimeType: inferMime(undeclared, apType) };
  }
  return null;
}

/** Every uploadable attachment of a Note, with its alt text. */
export function extractApMedia(note: { attachment?: unknown }): SourceMedia[] {
  const list = Array.isArray(note.attachment) ? note.attachment : note.attachment ? [note.attachment] : [];
  const media: SourceMedia[] = [];
  for (const raw of list) {
    const attachment = raw as ApAttachment;
    const resolved = resolveApAttachment(attachment);
    if (!resolved) continue;
    const alt = typeof attachment.name === 'string' ? attachment.name.trim() : '';
    media.push({ url: resolved.href, mimeType: resolved.mimeType, ...(alt ? { alt } : {}) });
  }
  return media;
}
