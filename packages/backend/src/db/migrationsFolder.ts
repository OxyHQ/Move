/**
 * Where the SQL migrations live — one constant for the migrator (`migrate.ts`)
 * and readiness (`postgres.ts`), so readiness can never assert against a
 * journal the migrator does not apply. Found by walking up to the package root
 * because the source (`src/db/`) and the build (`dist/src/db/`) sit at
 * different depths. The image ships `drizzle/` beside `package.json`.
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/** The nearest ancestor of `from` (inclusive) holding a `package.json`. */
function findPackageRoot(from: string): string {
  const { root } = parse(from);
  let dir = from;
  while (!existsSync(join(dir, 'package.json'))) {
    if (dir === root) {
      throw new Error(`No package.json above ${from}: the migrations folder cannot be resolved.`);
    }
    dir = dirname(dir);
  }
  return dir;
}

export const MIGRATIONS_FOLDER = join(findPackageRoot(__dirname), 'drizzle');
