import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const text = readFileSync(new URL('../.github/workflows/deploy-frontends.yml', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../.github/scripts/verify-manual-frontend.py', import.meta.url));
export function checkManualFrontend(workflow) {
  const job = workflow.jobs['deploy-frontend'];
  assert.ok(job.if.includes("vars.OXY_1519_ROLLOUT_HOLD != 'true'"));
  assert.ok(job.if.includes("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'"));
  assert.ok(job.if.includes("github.event_name == 'workflow_run'"));
  assert.ok(job.if.includes('github.event.workflow_run.head_sha == github.sha'));
  for (const input of ['expected_sha', 'ci_run_id']) assert.equal(workflow.on.workflow_dispatch.inputs[input].required, true);
  assert.equal(workflow.permissions.actions, 'read');
  assert.equal(workflow.env.DEPLOY_SHA, '${{ github.sha }}');
  const steps = job.steps;
  assert.equal(steps[0].with.ref, '${{ github.sha }}');
  const gates = steps.map((step, index) => ({step,index})).filter(({step}) => step.run === 'python3 .github/scripts/verify-manual-frontend.py');
  assert.equal(gates.length, 2);
  for (const {step} of gates) {
    assert.equal(step.if, "github.event_name == 'workflow_dispatch'");
    assert.equal(step.env.EXPECTED_SHA, '${{ inputs.expected_sha }}');
    assert.equal(step.env.EXPECTED_CI_RUN_ID, '${{ inputs.ci_run_id }}');
    assert.equal(step.env.EXPECTED_CI_WORKFLOW, '.github/workflows/ci.yml');
    assert.equal(step.env.OXY_1519_ROLLOUT_HOLD, '${{ vars.OXY_1519_ROLLOUT_HOLD }}');
  }
  assert.ok(gates[0].index < steps.findIndex(s => s.name === 'Install exact dependency graph'));
  assert.ok(gates[1].index < steps.findIndex(s => s.name === 'Deploy the Worker'));
}
assert.equal(createHash('sha256').update(helper).digest('hex'), '76ddd8121702f4b20b5c4da817da2ea3c211974566e14e9cffb5ee27b6964317');
const workflow = Bun.YAML.parse(text);
checkManualFrontend(workflow);
for (const mutate of [
  w => {w.jobs['deploy-frontend'].if = w.jobs['deploy-frontend'].if.replace("vars.OXY_1519_ROLLOUT_HOLD != 'true'", 'true');},
  w => {w.jobs['deploy-frontend'].if = w.jobs['deploy-frontend'].if.replace('github.event.workflow_run.head_sha == github.sha', 'true');},
  w => {w.jobs['deploy-frontend'].steps[0].with.ref = '${{ env.DEPLOY_SHA }}';},
  w => {w.jobs['deploy-frontend'].steps = w.jobs['deploy-frontend'].steps.filter(s => s.name !== 'Verify manual release source and CI');},
  w => {w.on.workflow_dispatch.inputs.ci_run_id.required = false;},
  w => {w.permissions.actions = 'write';},
]) {
  const bad = structuredClone(workflow); mutate(bad); assert.throws(() => checkManualFrontend(bad));
}
console.log('Move manual frontend workflow: positive + six mutation controls PASS');
