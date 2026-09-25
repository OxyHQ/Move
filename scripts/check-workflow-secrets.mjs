#!/usr/bin/env bun
/**
 * No workflow may read the whole secrets context in one expression.
 *
 * GitHub treats that expression as an exfiltration payload: every run then
 * completes `action_required` with ZERO jobs until a human approves it, which
 * reads as "no checks reported" (oxy-infra AGENTS.md §Secrets). Secrets are named
 * one by one. The pattern is matched on the EXPRESSION, with arbitrary spacing,
 * so a comment explaining the rule (which must not spell it) does not trip it
 * while any real use does.
 *
 * Self-tested by scripts/test-gates.mjs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WHOLE_SECRETS = /\$\{\{[^}]*\bto\s*json\s*\(\s*secrets\s*\)[^}]*\}\}/i;
const BARE_SECRETS = /\$\{\{\s*secrets\s*\}\}/i;

export function checkWorkflowText(name, text) {
  const errors = [];
  if (WHOLE_SECRETS.test(text) || BARE_SECRETS.test(text)) {
    errors.push(`${name}: reads the whole secrets context; name each secret explicitly`);
  }
  if (/uses:\s*cloudflare\/wrangler-action/i.test(text)) {
    errors.push(`${name}: cloudflare/wrangler-action is forbidden fleet-wide; call bunx wrangler@4`);
  }
  return errors;
}

if (import.meta.main) {
  const folder = new URL('../.github/workflows', import.meta.url).pathname;
  const files = readdirSync(folder).filter((file) => /\.ya?ml$/.test(file));
  if (files.length === 0) {
    console.error('::error::no workflows found (vacuity floor)');
    process.exit(1);
  }
  const errors = files.flatMap((file) => checkWorkflowText(file, readFileSync(join(folder, file), 'utf8')));
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
  console.log(`workflow secrets: ${files.length} workflow(s) OK`);
}
