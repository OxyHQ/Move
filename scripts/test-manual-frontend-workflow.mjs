import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const text = readFileSync(
  new URL('../.github/workflows/deploy-frontends.yml', import.meta.url),
  'utf8',
);
const helper = readFileSync(
  new URL('../.github/scripts/verify-manual-frontend.py', import.meta.url),
);
export function checkManualFrontend(workflow) {
  // The guards live on `gate`, which admits a run into the release lock.
  const gate = workflow.jobs.gate;
  assert.ok(gate.if.includes("vars.OXY_1519_ROLLOUT_HOLD != 'true'"));
  assert.ok(
    gate.if.includes("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'"),
  );
  assert.ok(gate.if.includes("github.event_name == 'workflow_run'"));
  for (const guard of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
    "github.event.workflow_run.head_branch == 'main'",
  ])
    assert.ok(gate.if.includes(guard), guard);
  // "Is this still main's head" alone strands a CI-green commit under a commit
  // that starts no CI; require-current-main.sh --gate decides instead.
  assert.ok(!gate.if.includes('head_sha == github.sha'));
  assert.equal(gate.steps[0].with.ref, '${{ env.DEPLOY_SHA }}');
  const admit = gate.steps.find((s) => s.id === 'admit');
  assert.equal(admit.run, 'bash .github/scripts/require-current-main.sh --gate');
  assert.equal(gate.outputs.release, '${{ steps.admit.outputs.release }}');

  const job = workflow.jobs['deploy-frontend'];
  assert.equal(job.needs, 'gate');
  assert.equal(job.if, "needs.gate.outputs.release == 'true'");
  assert.equal(job.concurrency.group, 'deploy-move-frontend');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.concurrency, undefined);
  for (const input of ['expected_sha', 'ci_run_id'])
    assert.equal(workflow.on.workflow_dispatch.inputs[input].required, true);
  assert.equal(workflow.permissions.actions, 'read');
  assert.equal(workflow.env.DEPLOY_SHA, '${{ github.event.workflow_run.head_sha || github.sha }}');
  const steps = job.steps;
  assert.equal(steps[0].with.ref, '${{ env.DEPLOY_SHA }}');
  const gates = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.run === 'python3 .github/scripts/verify-manual-frontend.py');
  assert.equal(gates.length, 2);
  for (const { step } of gates) {
    assert.equal(step.if, "github.event_name == 'workflow_dispatch'");
    assert.equal(step.env.EXPECTED_SHA, '${{ inputs.expected_sha }}');
    assert.equal(step.env.EXPECTED_CI_RUN_ID, '${{ inputs.ci_run_id }}');
    assert.equal(step.env.EXPECTED_CI_WORKFLOW, '.github/workflows/ci.yml');
    assert.equal(step.env.OXY_1519_ROLLOUT_HOLD, '${{ vars.OXY_1519_ROLLOUT_HOLD }}');
  }
  assert.ok(gates[0].index < steps.findIndex((s) => s.name === 'Install exact dependency graph'));
  assert.ok(gates[1].index < steps.findIndex((s) => s.name === 'Deploy the Worker'));
}
assert.equal(
  createHash('sha256').update(helper).digest('hex'),
  '76ddd8121702f4b20b5c4da817da2ea3c211974566e14e9cffb5ee27b6964317',
);
const workflow = Bun.YAML.parse(text);
checkManualFrontend(workflow);
for (const mutate of [
  (w) => {
    w.jobs.gate.if = w.jobs.gate.if.replace("vars.OXY_1519_ROLLOUT_HOLD != 'true'", 'true');
  },
  (w) => {
    w.jobs.gate.if = w.jobs.gate.if.replace(
      "github.event.workflow_run.conclusion == 'success'",
      'true',
    );
  },
  (w) => {
    w.jobs.gate.if = `${w.jobs.gate.if} && github.event.workflow_run.head_sha == github.sha`;
  },
  (w) => {
    w.jobs['deploy-frontend'].steps[0].with.ref = '${{ github.sha }}';
  },
  (w) => {
    w.jobs['deploy-frontend'].if = 'always()';
  },
  (w) => {
    w.jobs['deploy-frontend'].concurrency['cancel-in-progress'] = true;
  },
  (w) => {
    w.jobs['deploy-frontend'].steps = w.jobs['deploy-frontend'].steps.filter(
      (s) => s.name !== 'Verify manual release source and CI',
    );
  },
  (w) => {
    w.on.workflow_dispatch.inputs.ci_run_id.required = false;
  },
  (w) => {
    w.permissions.actions = 'write';
  },
]) {
  const bad = structuredClone(workflow);
  mutate(bad);
  assert.throws(() => checkManualFrontend(bad));
}
console.log('Move manual frontend workflow: positive + nine mutation controls PASS');
