# Backend image for Oxy Move. Three-stage build on oven/bun (linux/arm64 for
# AWS Graviton): `deps` installs the backend's production dependencies and
# nothing else, `builder` compiles shared-types + backend with the full dev
# tree, and `runtime` gets only the deps closure and the compiled output.

# Base images are pinned by digest: the digest is what the build pulls, and the
# tag is only for readability. A bump needs the new tag's multi-arch index
# digest and a re-review (re-pin in .github/scripts/reviewed-images.json).

# Stage 1: the runtime's node_modules, the backend's production closure only.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS deps
WORKDIR /app

# bunfig.toml pins the hoisted linker, so everything lands in /app/node_modules.
COPY package.json bun.lock bunfig.toml ./

# Every workspace member's package.json is required for a frozen-lockfile install
# to reconcile, even the frontend's, which this stage does not install.
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

# --filter installs only @move/backend's dependency closure (without it, every
# workspace's production dependencies come along: Expo, React Native, ~850
# packages). --omit=peer drops the optional native peers @oxy.so/core and
# @oxy.so/protocol declare (expo-crypto, expo-secure-store, async-storage,
# expo-modules-core), which drag React Native back in and which Node never
# loads. --ignore-scripts: the only install-time script left in this closure is
# msgpackr-extract's optional native build; msgpackr falls back to plain JS.
# The CI image smoke boots this closure and asserts what it does not contain.
RUN bun install --frozen-lockfile --production --ignore-scripts --omit=peer --filter '@move/backend'

# Stage 2: build (tsc -> dist), with dev dependencies. The backend tsconfig
# extends @oxy.so/app-preset (a frontend dependency), so this install is whole.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS builder
WORKDIR /app

# Root files first. The root tsconfig is the solution base each package extends.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

# --ignore-scripts skips the root postinstall (it builds shared-types before the
# source is copied); shared-types + backend are built explicitly below.
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/shared-types/ packages/shared-types/
COPY packages/backend/ packages/backend/

RUN cd packages/shared-types && bun run build
RUN cd packages/backend && bun run build

# Stage 3: runtime
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

# The image only ever runs production code; say so, so a one-shot started by
# hand (the migrator) behaves like the service instead of like a dev machine.
ENV NODE_ENV=production

# Everything below is copied without --chown: root owns it and the app user
# can only read it. The process writes no files; /tmp is the only writable path.
COPY --from=deps /app/node_modules/ node_modules/
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

# The SQL migrations, beside packages/backend/package.json — which is how
# src/db/migrationsFolder.ts resolves them. Needed by the one-shot migration
# task AND by every serving task, because readiness reads this journal to
# decide whether the database is current with the image (GET /ready).
COPY --from=builder /app/packages/backend/drizzle/ packages/backend/drizzle/

USER appuser
EXPOSE 3000

# Probe on 127.0.0.1 (musl resolves "localhost" to ::1 first, which would fail
# even though the server binds IPv4).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ready || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
