# create-oxy-app scaffold issues found while building Oxy Move

Scaffolded with create-oxy-app 0.3.2 from oxy `origin/main` 209a28b73
(`--minimal`, templates base + backend + deploy). Each item was measured, and
each is fixed in Move; the fix belongs in the templates.

1. **`server.ts` exports `{ app, server, io }`, and Bun then tries to `Bun.serve()` it.**
   Under Bun, an entry module whose exports look like a server config is also
   handed to `Bun.serve()`. The compiled `bun dist/server.js` (the image's CMD)
   binds Express and then throws `Bun.serve() needs either a routes object or a
   fetch handler`. Reproduced with a 10-line CJS entry exporting an Express app +
   `http.Server`. Fix: export nothing from the entrypoint.
   Move: `packages/backend/server.ts`.

2. **`OxyProvider baseURL={API_URL}` points the Oxy SDK at the app's own backend.**
   `API_URL` is the app API (`https://api.<app>`); `OxyProvider` needs Oxy's API
   (`https://api.oxy.so`, as Mention's `config.ts` uses). Fix: a separate
   `EXPO_PUBLIC_OXY_API_URL` defaulting to `https://api.oxy.so`.
   Move: `packages/frontend/lib/config.ts`, `app/_layout.tsx`.

3. **`.dockerignore` lets `*.tsbuildinfo` into the build context.** `**/dist` is
   excluded but a developer's `packages/shared-types/tsconfig.tsbuildinfo` is not,
   so `tsc` inside the image believes shared-types is up to date, emits nothing,
   and the backend build fails with `TS6305 Output file … has not been built`.
   Only a build from a developer checkout fails; CI's clean checkout passes.
   Fix: add `**/*.tsbuildinfo`.

4. **The runtime image does not set `NODE_ENV=production`, and the logger needs
   `pino-pretty` outside production.** `pino-pretty` is a devDependency the image
   strips, so any one-shot run by hand without `NODE_ENV=production` (the
   migrator) crashes at its first log line: `unable to determine transport target
   for "pino-pretty"`. Fix: `ENV NODE_ENV=production` in the runtime stage, and a
   logger that falls back to JSON when `pino-pretty` cannot be resolved.

5. **The deploy workflow cannot migrate.** `templates/deploy` only pushes an image
   and calls `update-service --force-new-deployment`: no `--phase=pre` migration
   before the rollout, no `--phase=post` after it, although the backend template's
   own `/ready` refuses traffic until the journal is applied. Its deploy role
   (`oxy-<app>-github-deploy`) also has no `ecs:RunTask`/`iam:PassRole` for that.
   Move adopted Mention's `deploy-ecs-image.sh` flow instead.

6. **Tests are not wired.** The backend template has no `test`/`typecheck` script
   and its build `tsconfig` includes every `**/*.ts`, so adding `src/__tests__`
   would compile tests (and `bun:test` imports) into `dist/` and the image.
   Move: build `tsconfig` excludes `src/__tests__`; `tsconfig.typecheck.json` puts
   them back under `tsc`.
