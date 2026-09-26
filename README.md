# Oxy Move

Bring your digital life to Oxy. The user taps **Connect**, signs in to the old
platform once (to prove the account is theirs), and Move brings over the
profile and follow list to **Oxy** and the posts to **Mention** — on web, iOS and
Android, at `move.oxy.so` (API `api.move.oxy.so`).

F1 platforms: **Mastodon** (and any ActivityPub server) and **Bluesky**. Threads,
Instagram, X, Medium and Substack are listed as "soon" (`GET /platforms`).

## What Move owns — and what it does not

| Where | Owns |
|---|---|
| **Oxy** | The account, the linked external accounts (proof of ownership), the `alsoKnownAs` alias, the profile, follows, blocks, files, notifications |
| **Mention** | The imported posts: `post_imports` (origin, dedup, undo), the "originally posted on" badge |
| **Move** | ONLY migration state: jobs, cursors, and the `source → destination` map |

Move never holds a third-party token (Oxy's OAuth proves ownership and discards
it). Mastodon and Bluesky content is read from public endpoints.

Oxy accepts profile, follow and block writes only from the **user's own
session**, so the Move **client** applies them. The backend builds the *plan*
(profile fields with media already copied into the user's Oxy files; follows —
and, for Bluesky, blocks — resolved to Oxy user ids in batches of 200) and the
client acknowledges what it applied (`POST /jobs/:id/plan/ack`). BEFORE each
write the client also acks the fact undo needs — the profile values it is about
to overwrite, which targets it already follows or blocks — and Move keeps the
first value of each fact (`migration_jobs.undo_facts`). So a migration resumes,
and undoes, from any device. Content is written by the **backend** to Mention
with Move's Oxy service token plus `X-Oxy-User-Id`.

## Architecture

```
packages/
  frontend/      Expo Router + Bloom + @oxy.so/services: home, connect, confirm, progress, history
  shared-types/  API types shared by both sides (job view, plan, platforms)
  backend/       Express + Socket.IO + PostgreSQL (drizzle via @oxy.so/db) + BullMQ
    src/sources/        one reader per platform: profile(), graph(), items() — resumable cursors
      mastodon.ts       ActivityPub actor/outbox/following (REST lookup fallback)
      bluesky.ts        public AppView XRPC; media = original blobs from the PDS
      http.ts           SSRF-safe JSON GET + per-platform backoff
    src/destinations/
      mention.ts        Mention ingest client; contract in mentionContract.ts (zod)
      oxy.ts            linked-account check, identity resolution, notification
      media.ts          copy media into Oxy behind ONE fleet-wide upload limiter
    src/pipeline/       runner (phases, checkpoints, deferral, pause), job service
    src/queue/          BullMQ queue `migration` (low concurrency) + the stalled-job sweep
    src/runtime/        composition, graceful shutdown, socket progress
    src/connectors/     pure ActivityPub/atproto pieces copied from Mention
```

### A job

1. `POST /jobs` verifies the linked account with Oxy (`GET /linked-accounts/by-user/:userId`)
   and inserts the job (at most one active job per user and platform — a
   partial unique index). It is enqueued on `migration`.
2. The worker re-verifies ownership, then runs **profile → graph → content**.
   A finished phase is never re-run; each phase checkpoints its source cursor.
3. **Content** reads newest first, copies media into the user's Oxy files,
   and sends batches of ≤ 50 to Mention. A self-reply or self-quote whose parent
   is not delivered yet is stored `deferred` and re-sent at the end, oldest
   first. Replies to other people and boosts are skipped by default
   (`includeRepliesToOthers`, `includeBoosts`).
4. A rate limit anywhere (source 429, Oxy's ~30 uploads/min/app media budget,
   Mention 429) **pauses** the job and re-enqueues it for later — never fails it.
   Transient errors retry with backoff from the last checkpoint. A job that
   lost its worker or its message is re-enqueued by a sweep that BullMQ
   schedules once per interval across the fleet (no leader election).
5. Progress is pushed to the user over Socket.IO (`migration:progress` to
   `user:<id>`) and readable at `GET /jobs/:id`. On completion Move creates an
   Oxy notification of type `system` (`entityType: app`, `entityId` = the job id).
6. **Undo** (`DELETE /jobs/:id`) deletes Mention's batch (`DELETE /imports/v1/batches/:jobId`)
   and returns the plan, the ack and the undo facts, so the client — on any
   device — unfollows and unblocks only what Move added and restores the profile.

### API (Oxy session required, except `/platforms`)

| Method | Path | |
|---|---|---|
| GET | `/platforms` | Available and upcoming platforms |
| POST | `/jobs` | `{ platform, linkedAccountId, options?, dryRun? }` — `dryRun` returns the preview (profile, counts, date range) |
| GET | `/jobs` | The user's migrations, newest first |
| GET | `/jobs/:id` | One job (status, phases, counters) |
| GET | `/jobs/:id/plan` | `{ plan, ack, undoFacts }`: profile, follow and block batches for the client (batches only once the graph phase has finished) |
| POST | `/jobs/:id/plan/ack` | `{ profileApplied?, followBatchesApplied?, blockBatchesApplied?, profileBefore?, alreadyFollowing?, alreadyBlocked? }` (facts: first write wins) |
| POST | `/jobs/:id/cancel` | Stop an active job |
| DELETE | `/jobs/:id` | Undo |

`GET /health` (liveness) and `GET /ready` (Postgres + every shipped migration
applied) are unauthenticated; the ALB probes `/ready`.

## Environment

All parsed in `packages/backend/src/config.ts`; see `packages/backend/.env.example`.

| Variable | Production source | |
|---|---|---|
| `DATABASE_URL` | SSM `/oxy/move/DATABASE_URL` | Required |
| `REDIS_URL` | SSM `/oxy/_shared/REDIS_URL` | Queue, media-upload limiter (optional locally) |
| `OXY_API_URL` | task env | default `https://api.oxy.so` |
| `MENTION_API_URL` | task env | default `https://api.mention.earth` |
| `OXY_SERVICE_API_KEY/SECRET` | — (never in production) | Local only; ECS attests `oxy-move-task` |
| `MEDIA_UPLOADS_PER_MINUTE` | default 30 | Oxy's per-app upload budget |
| `EXPO_PUBLIC_OXY_CLIENT_ID`, `EXPO_PUBLIC_API_URL` | GitHub `vars` | Frontend build |

## Development

```bash
bun install
docker compose -f docker-compose.postgres.yml up -d postgres
cp packages/backend/.env.example packages/backend/.env
bun run db:migrate --target-database=oxymove_dev
bun run dev:backend
bun run dev:frontend
```

```bash
bun run check                                   # AGENTS.md budget, gates (+ self-tests), typecheck, build
bun run lint
TEST_DATABASE_URL=postgres://… bun run test     # sources on recorded fixtures + pipeline on real Postgres
```

Schema changes: edit `packages/backend/src/db/schema/`, `bun run db:generate`,
then add `-- oxy:deploy-phase=pre|post` as the first line of the new `.sql`
(`scripts/check-migration-phase-markers.mjs` fails CI without it).

## Deploy

- **Backend** — `.github/workflows/deploy-aws.yml` after CI passes on `main`:
  digest-pinned arm64 image, a task revision derived from the running one,
  `--phase=pre` migrations before the rollout, `--phase=post` after it, smoke
  checks, rollback on failure (`.github/scripts/deploy-ecs-image.sh`, from Mention).
  AWS side: oxy-infra `terraform-uswest2/app-move.tf` and `iam-move-deploy.tf`.
- **Web** — `.github/workflows/deploy-frontends.yml`: `expo export`, then
  `bunx wrangler@4 deploy` to an assets-only Worker on `move.oxy.so`
  (`workers_dev = false`; `public/_headers` sets `nosniff` + `Referrer-Policy`).
- **Native** — EAS (`packages/frontend/eas.json`), bundle id / package `so.oxy.move`
  (`so.oxy.move.dev` with `APP_VARIANT=development`), scheme `oxymove`.

## Oxy grants

Move's Oxy application (seeded in Oxy's `SEED_APPS`, first-party, tier
`internal`) must hold these privileged scopes. Move relies on nothing broader —
in particular never on `federation:write`.

| Scope | Used by |
|---|---|
| `linked-accounts:read` | `GET /linked-accounts/by-user/:userId` — ownership check before creating and before running a job |
| `federation:identities:resolve` | `POST /federation/identities/lookup` and `/resolve` — followed accounts → Oxy user ids |
| `files:user-media:write` | `POST /assets/service/user-media` — media copied into the user's files |
| `federation:instance-fetch` | `POST /federation/instance-fetch/sign` — Oxy's instance actor signs a Mastodon GET that the server refused unsigned (authorized fetch); see [Reading Mastodon](#reading-mastodon) |
| `notifications:write` | `POST /notifications` (`type: system`, `title` ≤ 120, `message` ≤ 500, top-level `url` to `https://move.oxy.so/jobs/:id`, `entityType: app` with `entityId` = the job id, so a second migration is not deduped into a 409) |

Mention admits the same application by id (`MOVE_APPLICATION_ID`) for its
import API; no Oxy scope is involved there.

## Reading Mastodon

Move reads a Mastodon account's PUBLIC ActivityPub surface: the actor, the
outbox and `following`. It holds no key and no token.

- **Unsigned first.** Measured 2026-09-25: mastodon.social and hachyderm.io
  refuse the unsigned **actor** (401) but serve the collections unsigned.
- **Then signed by Oxy.** A 401/403 is retried once with an HTTP signature from
  Oxy's instance actor (`https://oxy.so/ap/users/instance`), which Oxy makes
  for Move through `POST /federation/instance-fetch/sign` (GET only, the
  instance key only, public https only; Oxy's
  `docs/identity/instance-fetch.md`). Every redirect hop is signed again. Once
  a COLLECTION of a host needed a signature (authorized-fetch mode), the rest
  of that job signs its reads of the host straight away; a refused actor alone
  does not switch it.
- **A signed refusal fails the job** with `source-requires-authorized-fetch`
  (the preview answers HTTP 422): the server blocks oxy.so, or federates only
  with an allow-list. Without a signed actor document Move still falls back to
  Mastodon's public REST lookup (`/api/v1/accounts/lookup`) for the profile.
- Oxy's 429 on signing (1200 signatures a minute for the app) pauses the job
  like a source 429.

## Known limitations

- **Mastodon blocks are not moved.** Mastodon's block list (`GET /api/v1/blocks`)
  needs the user's own token, and Oxy discards the token its OAuth received, so
  Move cannot read it. Bluesky blocks are public repo records
  (`app.bsky.graph.block` via `com.atproto.repo.listRecords` on the user's PDS)
  and are moved; without a resolvable PDS they are skipped.
- **Unlisted posts import as public.** Mention has no unlisted visibility for
  imports (`public` | `followers_only`); Mention's own ActivityPub ingest makes
  the same choice. Followers-only posts are not in the public outbox and are
  never read.
- **Audio attachments are dropped** before download (Mention imports images, GIFs and video).
- **Profile banners are not moved**: an Oxy profile has an avatar and no banner.
- **Replies whose target never arrives** (a reply to a post that was filtered,
  deleted at the source, or is not the user's) import as standalone posts with a
  link to the original target, so nothing stays deferred forever.

## The Mention ingest contract

Source of truth: Mention `docs/import.mdx`; Move's mirror is
`packages/backend/src/destinations/mentionContract.ts` and
`src/__tests__/mention.contract.test.ts` parses responses copied from Mention's
tests and checks every request against a copy of Mention's request schema.

- `POST /imports/v1/posts:batch` — ≤ 50 items AND ≤ 1 MB body (the client
  splits by both). Per item: `created` | `existing` | `deferred`
  (`parent_not_imported` / `quote_not_imported`: nothing written) | `failed`.
  A `deferred` item is stored with its payload and resent once its target is
  delivered; at the end, targets Mention already holds from an EARLIER job are
  kept (checked with lookup), the rest are dropped for a link.
- Media are `{ assetId, alt }` — Oxy asset ids Move uploaded as the user's
  media. Each upload is recorded on `migration_items.media_assets` before the
  batch is sent, so a retry after a crash reuses it instead of re-uploading.
- `DELETE /imports/v1/batches/:jobId` → `{ deleted, failed }`. `failed > 0` is
  shown on the job (`undo`) and leaves it retryable.
- `GET /imports/v1/lookup?platform=&sourceIds=…` (≤ 200) → `{ imported, federated }`;
  Move reads `imported`.
