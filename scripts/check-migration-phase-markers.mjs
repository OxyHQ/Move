#!/usr/bin/env bun
/**
 * Every drizzle migration must carry EXACTLY ONE deploy-phase marker, on its own
 * line: `-- oxy:deploy-phase=pre` or `-- oxy:deploy-phase=post`.
 *
 * `@oxy.so/db`'s migrator already refuses an unmarked file at apply time; this
 * gate moves that refusal to CI, before a deploy is attempted. It also refuses
 * two markers (ambiguous) and an unanchored mention (prose that merely talks
 * about the marker must not count as one). Every `.sql` in the journal must
 * exist and every `.sql` must be in the journal. A generated migration may not
 * contain a bound parameter (`$1`): drizzle renders a value interpolated into a
 * CHECK that way and it fails only at APPLY time.
 *
 * Self-tested by scripts/test-gates.mjs (positive and negative controls).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = /^-- oxy:deploy-phase=(pre|post)$/;

export function checkMigrationText(name, text) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  const markers = lines.filter((line) => MARKER.test(line));
  if (markers.length === 0) errors.push(`${name}: missing "-- oxy:deploy-phase=pre|post" on its own line`);
  if (markers.length > 1) errors.push(`${name}: ${markers.length} deploy-phase markers (exactly one allowed)`);
  const stray = lines.filter((line) => line.includes('oxy:deploy-phase') && !MARKER.test(line));
  if (stray.length > 0) errors.push(`${name}: malformed deploy-phase marker: ${stray[0].trim()}`);
  if (/\$\d/.test(text.replace(/--.*$/gm, ''))) errors.push(`${name}: contains a bound parameter ($N) — use sql.raw for CHECK constants`);
  return errors;
}

export function checkMigrationsFolder(folder) {
  const errors = [];
  const files = readdirSync(folder).filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) errors.push(`${folder}: no migrations found (vacuity floor)`);
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : { entries: [] };
  const tags = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  for (const file of files) {
    errors.push(...checkMigrationText(file, readFileSync(join(folder, file), 'utf8')));
    if (!tags.has(file)) errors.push(`${file}: not in meta/_journal.json`);
  }
  for (const tag of tags) if (!files.includes(tag)) errors.push(`${tag}: in the journal but missing on disk`);
  return { errors, count: files.length };
}

if (import.meta.main) {
  const folder = new URL('../packages/backend/drizzle', import.meta.url).pathname;
  const { errors, count } = checkMigrationsFolder(folder);
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(`deploy-phase markers: ${count} migration(s) OK`);
}
