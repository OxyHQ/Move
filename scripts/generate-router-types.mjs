#!/usr/bin/env bun
// Copied from Mercaria scripts/generate-router-types.mjs @ 906d7a56. Changed: the
// positive control is `/_sitemap` only — expo-router 57 no longer emits `/+not-found`
// in the typed-route union (measured on Move, expo-router 57.0.23).
/**
 * Generate `.expo/types/router.d.ts` for one Expo app, before `tsc` reads it.
 *
 * ## Why this exists
 *
 * All three apps set `experiments.typedRoutes: true`, and all three tsconfigs
 * already `include` `.expo/types/**\/*.ts`. What was missing is the FILE: it is
 * gitignored, and the only thing that wrote it was the Metro dev server
 * (`MetroBundlerDevServer.startTypeScriptServices`). CI never starts one, so
 * `tsc` type-checked against a tree in which it did not exist.
 *
 * With it absent, `expo-router`'s own declaration is
 *
 *     interface __routes {}
 *     type Href<T extends __routes = __routes> =
 *       T extends { href: any } ? T['href'] : string | HrefObject;
 *
 * — the conditional falls to its FALSE branch and `Href` degrades to
 * `string | HrefObject`. Every route literal then type-checks, including one
 * naming a route that does not exist. Generating the file declaration-merges a
 * populated `__routes` into the module and the conditional flips, which is what
 * turns `typedRoutes` from a setting into a check (#330).
 *
 * ## Why it hangs off `typecheck` rather than off a CI step
 *
 * A CI-only step makes the local command and the CI command different things,
 * and the failure mode is that a developer's green is not CI's. Generating
 * inside `typecheck` means the exact command CI runs is the exact command a
 * developer runs, and neither can typecheck against a stale or missing union.
 *
 * ## Two mechanics of Expo's generator this depends on
 *
 * 1. **`regenerateDeclarations` is `debounce(fn, 1000)`**, trailing edge, so
 *    `startTypescriptTypeGenerationAsync` RESOLVES ABOUT A SECOND BEFORE THE
 *    FILE EXISTS. Awaiting it and reading immediately finds nothing. Hence the
 *    poll below rather than a bare read.
 * 2. **The stale artefact is what makes that poll dangerous**, so the previous
 *    declaration is DELETED first. Polling for a file that is already there
 *    succeeds instantly against the last run's output, which is exactly the
 *    reading under which a generator that has stopped working looks fine.
 *
 * ## Why it asserts its own output, and what that assertion cost
 *
 * A generator that silently wrote nothing leaves `Href` degraded, `tsc` green,
 * and typed routes inert again — the precise bug this closes, re-introduced
 * invisibly. "It ran" is not evidence.
 *
 * The counter below is deliberately anchored on a leading `/` INSIDE the
 * backticks. The first version of this script excluded `$` from the route
 * literal instead, which silently matched only the two routes that carry no
 * group prefix — every real route is emitted as ``​`${'/(app)'}/cart`​`` — and
 * reported "2 routes" against a file that was completely correct. The floor
 * fired on all three apps and the thing it had caught was itself. A count is
 * only evidence once the counter has a positive control: `ROUTES_EVERY_APP_HAS`
 * is that control, and it is asserted before the floor so a broken pattern is
 * reported as a broken pattern rather than as a broken generator.
 */
import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * A vacuity floor, not a census — adding or removing a screen must not be a
 * chore here. It is set against the two numbers that bound it: a generator that
 * finds NO app files still emits the two synthetic routes below, and the
 * smallest real app is the POS at 9 (7 screens plus those two). Five separates
 * them with room on both sides.
 */
const MINIMUM_ROUTES = 5;

/**
 * Routes expo-router synthesises for every project, whatever the app tree
 * contains. They are the positive control on the COUNTER: if the pattern stops
 * matching, these disappear first, and their absence is a fact about the
 * pattern rather than about the app.
 */
const ROUTES_EVERY_APP_HAS = ['/_sitemap'];

/** The debounce is 1000 ms; this is a bounded wait, not a guess at the timing. */
const WRITE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const require = createRequire(import.meta.url);

/**
 * `@expo/cli` exposes this as the single entry point that sets typed routes up
 * for a project, and it explicitly supports being called with no Metro instance
 * and no server — the dev server is simply its only caller today. Calling the
 * lower-level `regenerateDeclarations` instead would mean re-deriving the app
 * root here, which is the one part of this that is genuinely Expo's to know
 * (the POS resolves its config through `app.config.js`, not `app.json`).
 */
const {
  startTypescriptTypeGenerationAsync,
} = require('@expo/cli/build/src/start/server/type-generation/startTypescriptTypeGeneration.js');

const declarationPath = path.join(projectRoot, '.expo', 'types', 'router.d.ts');
const relativeDeclaration = path.relative(projectRoot, declarationPath);

rmSync(declarationPath, { force: true });

await startTypescriptTypeGenerationAsync({ projectRoot });

const deadline = Date.now() + WRITE_TIMEOUT_MS;
let declaration;
for (;;) {
  try {
    declaration = readFileSync(declarationPath, 'utf8');
    break;
  } catch {
    if (Date.now() > deadline) {
      throw new Error(
        `Typed routes produced no ${relativeDeclaration} for ${projectRoot} within ` +
          `${WRITE_TIMEOUT_MS} ms. Without it \`Href\` degrades to \`string\` and every route ` +
          'literal type-checks, including one naming a route that does not exist. Check that ' +
          'app.json / app.config.js still sets `experiments.typedRoutes: true`.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Count DISTINCT route literals rather than characters. A file that is large
 * because the boilerplate is large, but whose union is empty, is exactly the
 * failure a size check reads as success.
 */
const routes = new Set([...declaration.matchAll(/`(\/[^`$]*)`/g)].map((match) => match[1]));

const missingControls = ROUTES_EVERY_APP_HAS.filter((route) => !routes.has(route));
if (missingControls.length > 0) {
  throw new Error(
    `The route counter in ${path.basename(import.meta.filename)} matched none of ` +
      `${missingControls.join(', ')} in ${relativeDeclaration}. Those routes are synthesised for ` +
      'every Expo Router project, so this is a broken PATTERN rather than a broken generator — ' +
      'a count that cannot see a known-present route is not evidence about the app.',
  );
}

if (routes.size < MINIMUM_ROUTES) {
  throw new Error(
    `Typed routes generated only ${routes.size} route(s) for ${projectRoot}, below the floor of ` +
      `${MINIMUM_ROUTES}. An empty or truncated union type-checks exactly like a correct one, so ` +
      'this is fatal rather than a warning.',
  );
}

console.log(`typed routes: ${routes.size} routes -> ${relativeDeclaration}`);
