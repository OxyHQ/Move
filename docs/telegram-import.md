# Telegram channel import (export reader)

A Telegram channel comes into Move as a **Telegram Desktop export**, not
through Telegram's API: the owner exports the channel ("Export chat history",
format **Machine-readable JSON**), zips the folder, and uploads the zip to their
own Oxy files. Move reads it from there with HTTP Range GETs on a short-lived
presigned URL. Nothing is written to local disk, and the task has 1 GiB of RAM
and 0.25 vCPU.

Status: the reading layer exists (below). It is **not wired**: `telegram` is
not in `MIGRATION_PLATFORMS`, and no route, DB CHECK or frontend screen knows
about it yet. That waits for the Oxy (upload and presigned read) and Mention
changes.

| Module | Role |
|---|---|
| `src/connectors/upload/zipArchive.ts` | Random-access zip over a `RangeReader` (yauzl, zip64 included) |
| `src/connectors/telegram/exportSchema.ts` | zod schemas for the header and a message; unknown keys pass |
| `src/connectors/telegram/textEntities.ts` | `renderTelegramText(message)`, which returns `{ text, links }` |
| `src/connectors/telegram/exportReader.ts` | Finds `result.json`, streams it, resolves media paths |
| `src/sources/telegram.ts` | `openTelegramSource(zip)` → `TelegramSource` (the `Source` contract) |

## The archive

`openZip(reader, limits)` reads the central directory once. Small reads come
from four cached 1 MiB blocks, so 250k entries cost about 20 range requests.
Entry data streams in 1 MiB chunks. It refuses:

| Refusal | Code |
|---|---|
| More than 250 000 entries, checked before any entry is read | `zip_too_many_entries` |
| An encrypted entry | `zip_encrypted` |
| An absolute path, a `..` segment or a NUL character | `zip_unsafe_path` |
| The same path twice, an unreadable or corrupt archive | `zip_invalid` |
| A declared size over the caller's cap | `zip_entry_too_large` |
| An entry over 1 MiB that claims more than 100:1 | `zip_bomb` |
| More inflated bytes than declared (yauzl's check, plus ours) | `zip_entry_size_mismatch` |

The ratio check also covers overlapping-entry bombs: each entry is bounded on
its own. File names without the UTF-8 flag that are valid UTF-8 are read as
UTF-8, because macOS Archive Utility writes them that way.

If the `RangeReader` itself fails (network, expired URL), its own error comes
back unchanged. It is never reported as a bad archive, so the job can retry it.

## The export

- `result.json` is the shallowest `result.json` in the archive, at the root or
  under the export folder. A deeper one is a file someone posted. Media paths are
  relative to its folder.
- No `result.json` but a `messages*.html` → `telegram_export_not_json`.
- A whole-account export (top-level `personal_information`) or any chat that is
  not `public_channel` / `private_channel` → `telegram_export_unsupported_chat`.
- Anything malformed, including a refusal from the zip layer → `telegram_export_invalid`.
  `TelegramExportError.detail` carries the zip code.
- `result.json` is never parsed in one piece. It is inflated as a stream and
  fed to `@streamparser/json`, which emits `name`/`type`/`id` and then each
  element of `messages`, and keeps none of them once emitted.

## Items

- **Ids.** `sourceId` = `<channelId>/<messageId>` and `sourceUrl` =
  `https://t.me/c/<channelId>/<messageId>`. The channel id has any `-100` prefix
  removed. Mention's operator one-shot import keys items the same way, so a Move
  import dedupes against it. The structured provenance is `sourceAccountId` =
  `<channelId>` and `sourceItemId` = `<messageId>`, both from the album head. `profile()` is `{ actor: 'tg:<channelId>', handle:
  name, displayName: name }`, and `graph()` yields nothing.
- **Order.** Oldest first, as exported.
- **Dates.** `createdAt` comes from `date_unixtime` × 1000. The `date` field is
  the exporting machine's local time and is never read. `edited*` is ignored.
  A message without `date_unixtime` (exports before 2021) is skipped as `unsupported`.
- **Albums.** The export has no group id, so consecutive messages with media and
  the same `date_unixtime` (and the same forwarded state) fold into one item,
  cut at 10. The text is the first non-empty one, and the ids are the head
  message's. Stickers, voice messages and round videos never join an album.
- **Text.** `renderTelegramText`:
  - Formatting entities keep their text, and `custom_emoji` becomes its
    fallback emoji.
  - For `text_link`, the anchor stays in the text and the `href` goes into
    `links`, deduplicated, up to 10. After that the href is written inline as
    `anchor (href)`. An anchor of only emoji or whitespace adds no link,
    because Telegram links emoji to emojipedia. An anchor that is the URL
    itself is replaced by the full href, and a non-http(s) href is dropped.
  - Each line of a `blockquote` is prefixed with `> `.
  - The legacy `text` field (a string or a mixed array) is the fallback.
  - `\r\n` becomes `\n`, and the end is trimmed.
- **Polls, locations, contacts** become text: `Poll: <q>` then one `- <answer>`
  line per answer, `Location: <place>, <address> (<lat>, <lon>)`, and `Contact:
  <name>, <phone>`.
- **Media.**
  - Kept: `photo` (image/jpeg), and `file` with `media_type` `video_file`,
    `animation` or `video_message` (their `mime_type`, when video/* or
    image/gif), plus `.webp` stickers.
  - Dropped: voice, audio, documents, `.tgs` and `.webm` stickers,
    placeholders (`(File not included. …)`, `(File exceeds maximum size. …)`),
    files missing from the archive, and anything over
    min(`MEDIA_MAX_BYTES`, 40 MiB), which is Oxy's user-media limit.
  - Each dropped file is counted in the item's `mediaSkipped`.
  - A kept file's URL is `telegram-export:<encodeURIComponent(zip path)>`.
    `TelegramSource.readMedia(url, maxBytes)` serves its bytes.
- **Skips.**
  - `service` messages are `unsupported`.
  - Forwards are `boost-disabled` unless `includeBoosts` is set. With it, the
    text is prefixed `Forwarded from <name>:`.
  - A message left with no text and no media is `empty`.
- **Quotes.** `reply_to_message_id` in the same channel becomes `quoteSourceId`
  = the `<channelId>/<messageId>` of the replied message's **album head**. That
  happens only when the head was imported. A reply to a service message, a
  deleted message or another chat (`reply_to_peer_id`) quotes nothing.
- **Visibility.** `public_channel` is `public`, and `private_channel` is `followers`.
- **Cursor.** `{ lastMessageId }` is the last member of the last value yielded.
  A resume streams the export again from the start, rebuilding the
  album-member → head map and the imported set, and yields only what comes
  after the cursor.

## Wiring still to do

- Add `telegram` to `MIGRATION_PLATFORMS`, the DB CHECKs, the source factory and
  the frontend. Switch `TelegramSource` from `TelegramSourceContract` to
  `implements Source`.
- Send `sourceAccountId` and `sourceItemId` to Mention (Mention #1426) in
  `destinations/mention.ts` and `mentionContract.ts`.
- Make the media copier use `source.readMedia` for `telegram-export:` URLs —
  those have no URL Oxy could import, so their bytes go through
  `OxyServer.assets.uploadUserMedia` behind the same limiter
  ([`oxy-files.md`](oxy-files.md)) — and add `mediaSkipped` to the job counters.
- `runner.ts` `referenceUrl()` understands only http(s) and `at://` ids. A
  `<channelId>/<messageId>` quote that has to fall back to a link needs mapping
  to its `https://t.me/c/…` URL.
- Add a `RangeReader` over the presigned Oxy file URL, through
  `safeUpstreamFetch`, with a refresh when the URL expires mid-job.
