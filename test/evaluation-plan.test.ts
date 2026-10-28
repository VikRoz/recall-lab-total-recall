import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEvaluationPlan, prospectiveCases } from '../src/evaluation-plan.ts';
import { hash } from '../src/evaluation.ts';
import { Journal } from '../src/local-journal.ts';

test('the offline plan freezes sixteen cases, three families and twenty-six unique requests', async () => {
  const a = await buildEvaluationPlan(), b = await buildEvaluationPlan();
  assert.equal(hash(a), hash(b)); assert.equal(a.cases.length, 16); assert.equal(a.conditions.length, 32);
  assert.equal(a.callLimit, 26); assert.equal(a.requestKeys.length, 26);
  assert.equal(new Set(a.cases.map(c => c.task.family)).size, 3);
  assert.equal(a.conditions.filter(c => c.cohort === 'prospective').length, 8);
});
test('no result, oracle or expected answer enters model requests; only memory differs within pairs', async () => {
  const plan = await buildEvaluationPlan();
  for (const p of plan.conditions) {
    assert.deepEqual(Object.keys(p.context).sort(), ['memories', 'offers', 'task']);
    assert.deepEqual(Object.keys(JSON.parse(p.request.body.messages[1].content)).sort(), ['memories', 'offers', 'task']);
    assert.equal(JSON.stringify(p.request.body).includes('synthetic-owner'), false);
    assert.equal(p.request.body.max_tokens, 512); assert.equal(p.request.body.temperature, 0);
    assert.ok(new TextEncoder().encode(JSON.stringify(p.request.body.messages)).length <= 3500);
    const other = plan.conditions.find(c => c.caseId === p.caseId && c.memoryEnabled !== p.memoryEnabled)!;
    assert.deepEqual({ ...p.context, memories: [] }, { ...other.context, memories: [] });
  }
});
test('prospective combinations test distinct failure interactions, exact budgets and correction visibility', async () => {
  const [mixed, large, future, recovered] = prospectiveCases(), plan = await buildEvaluationPlan();
  assert.equal(mixed.records.length, 2); assert.equal(mixed.task.requiredFields.includes('objectType'), false);
  assert.equal(large.task.budget, '9007199254740993'); assert.equal(large.results[0].fields.owner, 'synthetic-wrong-owner');
  const futureOn = plan.conditions.find(p => p.caseId === future.id && p.memoryEnabled)!;
  assert.equal(futureOn.context.memories.length, 1); assert.equal(futureOn.context.memories[0].verdict, 'fail');
  const recoveredOn = plan.conditions.find(p => p.caseId === recovered.id && p.memoryEnabled)!;
  assert.equal(recoveredOn.context.memories[0].verdict, 'pass'); assert.equal(recovered.task.budget, '1');
});
test('an identical arm is disclosed and deduplicated; changing a request cannot reuse its effect', async () => {
  const plan = await buildEvaluationPlan(), journal = new Journal(':memory:'); let calls = 0;
  try {
    for (const c of plan.conditions) await journal.once('eval:benchmark:v1:model:' + c.key, 'model', c.request, async () => { calls++; return 'synthetic result'; });
    assert.equal(calls, plan.callLimit);
    const first = plan.conditions[0];
    await assert.rejects(journal.once('eval:benchmark:v1:model:' + first.key, 'model', { altered: true }, async () => {}), /IDEMPOTENCY_CONFLICT/);
    assert.equal((journal.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as any).n, 0);
  } finally { journal.close(); }
});
test('a freshness observation without its numeric threshold remains unassessable in the planned protocol', async () => {
  const plan = await buildEvaluationPlan();
  assert.equal(plan.citationContract, 'memory-citations-v1');
  assert.ok(plan.limitations.some(s => s.includes('numeric freshness')));
  assert.ok(plan.acceptance.separatelyReport.includes('citationSupport'));
});
test('the live runner refuses unapproved work before reading a plan or credentials', () => {
  const file = fileURLToPath(new URL('../scripts/evaluate-benchmark.ts', import.meta.url));
  const r = spawnSync(process.execPath, ['--experimental-strip-types', file], { env: { ...process.env,
    RECALL_EVAL_BENCHMARK_CONFIRMED: 'false' }, encoding: 'utf8' });
  assert.equal(r.status, 2); const report = JSON.parse(r.stdout);
  assert.equal(report.code, 'BENCHMARK_NOT_CONFIRMED'); assert.equal(report.modelCallsThisInvocation, 0);
});
