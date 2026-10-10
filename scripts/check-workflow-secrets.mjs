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
 * Runtime secrets live ONLY in SSM /oxy/move/* and /oxy/_shared/* (oxy-infra
 * runbook 46): no workflow step may write SSM, and a workflow may read only the
 * repo secrets CI itself spends (CI_ONLY_SECRETS). Until 2026-10-10 the deploy
 * copied DATABASE_URL from a repo secret into SSM on every run, which made
 * GitHub a second, overriding source of a production credential. Comment lines
 * are skipped so the rule can be explained where it applies.
 *
 * Self-tested by scripts/test-gates.mjs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WHOLE_SECRETS = /\$\{\{[^}]*\bto\s*json\s*\(\s*secrets\s*\)[^}]*\}\}/i;
const BARE_SECRETS = /\$\{\{\s*secrets\s*\}\}/i;
const SECRET_READ = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const SSM_WRITE = /\bssm\s+(put-parameter|delete-parameters?|label-parameter-version)\b/i;

/** The only repo secrets a workflow may read: what CI itself spends. */
export const CI_ONLY_SECRETS = new Set([
  'GITHUB_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'NPM_TOKEN',
  'ADD_TO_PROJECT_TOKEN',
]);

export function checkWorkflowText(name, text) {
  const errors = [];
  if (WHOLE_SECRETS.test(text) || BARE_SECRETS.test(text)) {
    errors.push(`${name}: reads the whole secrets context; name each secret explicitly`);
  }
  const code = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (SSM_WRITE.test(code)) {
    errors.push(`${name}: writes SSM; runtime secrets are set in SSM by their owner, never by a workflow`);
  }
  for (const [, secret] of code.matchAll(SECRET_READ)) {
    if (!CI_ONLY_SECRETS.has(secret)) {
      errors.push(`${name}: reads repo secret ${secret}; runtime secrets live only in SSM`);
    }
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
