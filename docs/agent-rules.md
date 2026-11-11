# Agent rules: detail

The short form of these rules is in [`AGENTS.md`](../AGENTS.md). This file holds the
rules that were moved out of it, with their reasons.

## Oxy SDK

- Backend auth is `@oxy.so/core/server` only: `createOxyAuthMiddleware`, `createOxyCors`,
  `createOxyRateLimit` and `OxyServer#middleware.socket()`. No app-local auth, bearer parsing
  or CORS. Call your own API via `oxyServices.createLinkedClient({ baseURL })`.
- Gate private API calls on `useAuth().canUsePrivateApi`; the root `Stack` alone swaps
  `(auth)` and `(app)`.
- Theming is NativeWind via `BloomProvider`; never hardcode brand colors.
- All Expo config comes from `@oxy.so/app-preset`; fix the preset, never copy config back
  into the app.

## Database (drizzle)

- `src/db/schema/index.ts` is the single source of truth; a table missing there gets no
  migration and no typed query.
- Declare columns camelCase; `DATABASE_CASING` names them in SQL. Never spell snake_case by
  hand or use `column.name`: use `sqlColumnName()` from `@oxy.so/db`.
- `oxyUserId` carries no foreign key and there is no `users` table; Oxy owns identity.
- Extensions go in `REQUIRED_EXTENSIONS` in `src/db/migrate.ts`, not in a migration.
- Never hand-write a migration, and add `-- oxy:deploy-phase=pre|post` to each generated
  `.sql` (gate: `scripts/check-migration-phase-markers.mjs`).

## Move's scope

- Move stores ONLY migration state (`migration_jobs`, `migration_items`). Identity, linked
  accounts, profile, follows, blocks and files are Oxy's; posts are Mention's.
- Never hold a third-party token. Oxy's OAuth proves ownership and discards it; sources read
  PUBLIC data only.
- Profile, follows and blocks are written by the CLIENT with the user's session (Oxy refuses
  service tokens there). The backend only builds the plan.
- Verify linked accounts before create/run with the original session/task proof; persist
  task IDs only, revoke on cancel, use fresh session authority for undo
  ([first-party-platform.md](first-party-platform.md)).
- Import Mention schemas/limits from `@oxy.so/mention-contracts` and transport from its
  `/server` SDK; no copied contract.
- A rate limit (source 429, Oxy media budget, Mention 429) PAUSES a job and re-enqueues it;
  it never fails it. Oxy media imports go through the one shared limiter in
  `destinations/media.ts`.
- Media is imported BY URL in Oxy (`assets.importUserMedia`), never downloaded by Move; Move
  registers no file reference. Mention and the profile use the files ([oxy-files.md](oxy-files.md)).
- Remote reads go through `publicGet` in `utils/safeUpstreamFetch.ts` (SSRF-safe, IP-pinned,
  byte-capped); never `fetch()` a URL a remote chose.
- ActivityPub reads go unsigned, then on 401/403 signed by Oxy's instance actor
  (`federation:instance-fetch`); Move never holds a key.
- Code copied from Mention carries a provenance header (path + commit). Keep it when editing.
- Gates need a negative control (`scripts/test-gates.mjs`).
- `packages/backend/server.ts` exports nothing: Bun auto-serves a server-shaped entry export
  and crashes.
