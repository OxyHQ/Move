# Oxy Move

Migrates a user's data from other networks into Oxy and Mention: Expo / React Native frontend
plus an Express + Socket.IO backend on the Oxy SDK.

## Commands

```bash
bun install
docker compose -f docker-compose.postgres.yml up -d postgres
cp packages/backend/.env.example packages/backend/.env
bun run db:migrate --target-database=oxymove_dev
bun run dev:backend        # API
bun run dev:frontend       # Expo
bun run lint               # Biome + frontend eslint; bun run lint:fix to apply
bun run typecheck
bun run test               # needs TEST_DATABASE_URL
bun run build
bun run check              # AGENTS.md budget, gates, typecheck, build
```

## Map

- `packages/backend`, `packages/frontend`, `packages/shared-types`: the three workspaces.
- `README.md`: layout, environment table, deploy. `docs/`: design notes per topic.

## Conventions that differ from defaults

- Use bun only, and commit `bun.lock` with its `package.json` (the lockfile gate fails otherwise).
- Mount ONE `OxyProvider` from `@oxy.so/services` with `EXPO_PUBLIC_OXY_CLIENT_ID`; sign-in is the
  in-app `OxyAccountDialog`, never an IdP redirect.
- Backend auth comes only from `@oxy.so/core/server`; no app-local auth or CORS.
- Change the schema in `src/db/schema/index.ts` then `bun run db:generate`; never hand-write a
  migration (a table absent from the schema gets no migration).
- Apply migrations only with `bun run db:migrate --target-database=<name>`, never `drizzle-kit migrate`.
- Use `sqlColumnName()` from `@oxy.so/db`, never snake_case by hand or `column.name`.
- A rate limit pauses and re-enqueues a job; it never fails it (a failed job loses the user's progress).
- Remote reads go through `publicGet` in `utils/safeUpstreamFetch.ts`; never `fetch()` a URL a remote chose (SSRF).
- Import Mention schemas from `@oxy.so/mention-contracts`; no copied contracts.
- `packages/backend/server.ts` exports nothing: Bun auto-serves a server-shaped export and crashes.
- Biome owns format and lint; `packages/frontend/eslint.config.js` holds only expo-plugin rules Biome lacks.

More rules with their reasons: [`docs/agent-rules.md`](docs/agent-rules.md).

## Boundaries

- Never store anything beyond migration state (`migration_jobs`, `migration_items`): identity,
  profile, follows, blocks and files are Oxy's, posts are Mention's.
- Never hold a third-party token or read non-public source data: Oxy's OAuth proves ownership only.
- Never write profile, follows or blocks from the backend: Oxy refuses service tokens there, so the client writes them.
- Never download media in Move: import it by URL through Oxy (`assets.importUserMedia`).
- Ask first before widening Move's scope or adding a table.

## Testing

- Backend changes: `bun run --cwd packages/backend test` with `TEST_DATABASE_URL` set (pipeline tests never skip).
- Frontend changes: `bun run --cwd packages/frontend test`.
- New gates need a negative control in `scripts/test-gates.mjs`.
- Done means `bun run check` and `bun run test` pass.

## PR and commits

- Branch from `main`; open a PR; CI runs lint, gates, typecheck, build and tests.
- Keep `AGENTS.md` under its byte budget (`bun run validate:agents-md`); put design notes in `docs/`.

## Secrets

- Production secrets live only in SSM (`/oxy/move/*`); GitHub holds none. Local values come
  from `packages/backend/.env` (copied from `.env.example`). Never print or commit them.

## Links

- [README](README.md), [first-party platform ledger](docs/first-party-platform.md), [Oxy files](docs/oxy-files.md)
- [Oxy engineering standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md),
  [lint and format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md),
  [gate writing](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/gate-writing.md),
  [Postgres and Drizzle](https://github.com/OxyHQ/oxy/blob/main/docs/postgres-and-drizzle.md),
  [npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md)

Owner: @NateIsern (Nate Isern). Last reviewed: 2026-11-11.
