#!/usr/bin/env bun
/**
 * Positive AND negative controls for the repository gates: each must PASS on a
 * known-good input and FAIL on each known-bad one. A gate that cannot fail is
 * worse than none (~/Oxy/docs/gate-writing.md).
 */
import { checkMigrationText } from './check-migration-phase-markers.mjs';
import { checkWorkflowText } from './check-workflow-secrets.mjs';

let failures = 0;
function expect(label, errors, shouldFail) {
  const failed = errors.length > 0;
  if (failed !== shouldFail) {
    failures++;
    console.error(`::error::gate self-test "${label}": expected ${shouldFail ? 'a failure' : 'a pass'}, got ${JSON.stringify(errors)}`);
  }
}

// Migration markers.
expect('pre marker passes', checkMigrationText('a.sql', '-- oxy:deploy-phase=pre\n\nCREATE TABLE x ();'), false);
expect('post marker passes', checkMigrationText('a.sql', '-- oxy:deploy-phase=post\nDROP TABLE x;'), false);
expect('unmarked fails', checkMigrationText('a.sql', 'CREATE TABLE x ();'), true);
expect('two markers fail', checkMigrationText('a.sql', '-- oxy:deploy-phase=pre\n-- oxy:deploy-phase=post\n'), true);
expect('indented marker fails', checkMigrationText('a.sql', '  -- oxy:deploy-phase=pre\nCREATE TABLE x ();'), true);
expect('unknown phase fails', checkMigrationText('a.sql', '-- oxy:deploy-phase=all\nCREATE TABLE x ();'), true);
expect('prose mention does not count', checkMigrationText('a.sql', '-- see oxy:deploy-phase=pre docs\nCREATE TABLE x ();'), true);
expect('bound parameter fails', checkMigrationText('a.sql', "-- oxy:deploy-phase=pre\nALTER TABLE x ADD CHECK (s in ($1));"), true);

// Workflow secrets.
expect('named secret passes', checkWorkflowText('w.yml', 'env:\n  A: ${{ secrets.A }}\n'), false);
expect('toJSON(secrets) fails', checkWorkflowText('w.yml', 'env:\n  ALL: ${{ toJSON(secrets) }}\n'), true);
expect('spaced tojson fails', checkWorkflowText('w.yml', 'x: ${{ tojson( secrets ) }}'), true);
expect('bare secrets fails', checkWorkflowText('w.yml', 'x: ${{ secrets }}'), true);
expect('wrangler-action fails', checkWorkflowText('w.yml', '- uses: cloudflare/wrangler-action@v3'), true);

if (failures > 0) process.exit(1);
console.log('gate self-tests: all controls behaved');

// Closed manual source/CI admission, including adversarial workflow mutations.
await import('./test-manual-frontend-workflow.mjs');
