import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvaluationPlan } from '../src/evaluation-plan.ts';
import { hash } from '../src/evaluation.ts';
import { replayPolicy } from '../src/policy-replay.ts';

async function fixture() {
  const plan = await buildEvaluationPlan();
  const proposal = { serviceId: null, reason: 'SYNTHETIC TEST FIXTURE, not live model inference', memoryIds: [] };
  return { testFixture: true, status: 'BENCHMARK_COMPLETED', mode: 'LIVE_MODEL_SYNTHETIC_INPUTS',
    planHash: hash(plan), modelId: plan.modelId, rows: plan.conditions.map(c => ({ caseId: c.caseId,
      memoryEnabled: c.memoryEnabled, context: structuredClone(c.context), requestKey: c.key,
      decision: structuredClone(proposal), rawResponseHash: hash(JSON.stringify(proposal)) })) };
}
test('replay admits only exact original requests and reports changed input without a fabricated model answer', async () => {
  const source = await fixture(), before = structuredClone(source), result = await replayPolicy(source, hash(source));
  assert.equal(result.completedReplayArms, 31); assert.equal(result.notRunChangedArms, 1); assert.equal(result.modelCalls, 0);
  const unknown = result.rows.find(r => r.replayStatus === 'not_run_changed_request')!;
  assert.equal(unknown.caseId, 'prospective-mixed-failures'); assert.equal(unknown.verdict, 'not_run');
  assert.equal(unknown.serviceProjections, 0); assert.equal(unknown.decision, null); assert.deepEqual(unknown.sourceConditions, []);
  const irrelevant = result.rows.find(r => r.caseId === 'evidence-field-not-required' && r.memoryEnabled)!;
  assert.deepEqual(irrelevant.sourceConditions, ['evidence-field-not-required:off']);
  assert.deepEqual(source, before);
});
test('replay refuses a changed source digest, context or unseen reference', async () => {
  const source = await fixture(), expected = hash(source); source.rows[0].decision.reason = 'tampered';
  await assert.rejects(replayPolicy(source, expected), /POLICY_REPLAY_SOURCE_HASH_MISMATCH/);
  const context = await fixture(); context.rows[0].context.task.budget = '999';
  await assert.rejects(replayPolicy(context, hash(context)), /POLICY_REPLAY_SOURCE_MISMATCH/);
  const reference = await fixture(); (reference.rows[0].decision.memoryIds as string[]).push('invented');
  await assert.rejects(replayPolicy(reference, hash(reference)), /UNKNOWN_MEMORY_REFERENCE/);
});
test('the same recorded request cannot supply contradictory cached decisions', async () => {
  const source = await fixture();
  const first = source.rows.find(r => source.rows.filter(x => x.requestKey === r.requestKey).length > 1)!;
  const duplicate = source.rows.find(r => r !== first && r.requestKey === first.requestKey)!;
  duplicate.decision.reason = 'conflicting synthetic cache entry';
  await assert.rejects(replayPolicy(source, hash(source)), /POLICY_REPLAY_CACHE_CONFLICT/);
});
