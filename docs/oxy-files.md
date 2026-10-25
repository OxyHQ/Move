# Move and Oxy Files

How Move gets a migrated account's media into Oxy, and why Move registers no
file references (Oxy ADR 0043, "Who owns a file, who uses it, and when it goes
away", `docs/adr/0043-application-owned-files.md` in OxyHQ/oxy).

## Import by URL, in Oxy

`destinations/media.ts` hands each media URL to Oxy:
`OxyServer.assets.importUserMedia(oxyUserId, url, { visibility: 'public' })`
(`POST /assets/service/user-media/import`, ADR 0043 D7, the original task/account proof, which Move already holds). Oxy fetches the URL with its
own SSRF-safe fetcher (https only, public addresses only, bounded redirects,
40 MiB, image or video) and stores the file **owned by the user**. Move never
downloads a media file.

- **Dedupe.** Oxy remembers each (user, URL) it imported. A second migration of
  the same account, or a retry, answers the existing file without a download.
  `migration_items.media_assets` (url → file id) still records each import
  before its batch is sent, so a resumed run does not even ask Oxy again or
  spend the shared budget.
- **One budget.** Imports count against Oxy's per-application media limit
  (the same ~30/min as uploads), behind the fleet-wide limiter in `media.ts`.
  Oxy's 429 carries `retryAfterSeconds`; the limiter blocks every task until
  then and the job pauses.
- **Failures, per file.**

  | Oxy answers | Meaning | Move |
  |---|---|---|
  | 400 `INVALID_SOURCE_URL` | not https, or credentials in the URL | drop the file |
  | 422 `SOURCE_URL_REFUSED` | a private address, or a redirect to http | drop the file |
  | 413 `PAYLOAD_TOO_LARGE` | over 40 MiB | drop the file |
  | 415 `UNSUPPORTED_MEDIA_TYPE` | not an image or video Oxy stores | drop the file |
  | 502 `SOURCE_FETCH_FAILED`, source 4xx (not 408/429) | gone or forbidden at the source | drop the file |
  | 502 otherwise, 504 `SOURCE_FETCH_TIMEOUT`, 409, 5xx | transient | retry the run from its checkpoint |
  | 429 | Oxy's media budget | pause the job |
  | 401 / 403 | The original workload/requester authority is unavailable | stop with `authority-unavailable`, retaining checkpoints |

  A dropped file leaves the post without it, as before.
- **Trash.** If the user already holds those bytes in their trash, Oxy returns
  that file with `status: 'trash'`. Move does not bring it back and does not
  hand Mention a file Oxy will not serve: the post goes without it.

## Who uses the files: not Move

A file reference says "this application uses this file in this entity", and
only the application holding it can remove it. Move creates no entity that uses
a file:

| File | Used by | Entity | Registered by |
|---|---|---|---|
| A post's media | **Mention** | the post Mention creates from `POST /imports/v1/posts:batch` | Mention, with its own service token |
| The avatar | **Oxy** (the profile) | the user's profile, set by the Move client with `users.updateMe({ avatar })` | Oxy, when the profile's avatar changes |

`migration_items.media_assets` is Move's resume bookkeeping, not a use. A Move
reference would outlive the post (Mention deletes posts on undo, and a user
deletes posts in Mention, without Move knowing) and keep a file "in use" that
nothing shows. So Move does not pass `reference` on import, holds no
`files:references:write`, runs no reconciliation and needs no file-events
endpoint.

The files are the user's (ADR 0043 D5): when no application uses one, Oxy marks
it *not in use* in the user's file manager and never deletes it. Undoing a
migration deletes the posts in Mention; the imported media stay in the user's
files for them to keep or delete.

What the users of the files must do is in [`follow-ups.md`](follow-ups.md).

## Telegram exports

A Telegram Desktop export has no URL to import: its media are bytes inside the
uploaded zip (`TelegramSource.readMedia`). When Telegram is wired
([`telegram-import.md`](telegram-import.md)), those go through
`OxyServer.assets.uploadUserMedia(oxyUserId, bytes, mime)` behind the same
limiter.
