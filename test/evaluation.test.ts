import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { evaluationCorpus } from '../src/evaluation-corpus.ts';
import { deterministicModel, evaluateArm, FrozenMemory, hash, summarize } from '../src/evaluation.ts';
import { canonical } from '../src/domain.ts';

test('the twelve corpus cases differ semantically, not just by task labels', () => {
  const cases = evaluationCorpus();
  assert.equal(cases.length, 12);
  assert.equal(new Set(cases.map(c => c.id)).size, 12);
  const signatures = cases.map(c => hash({ ...c, id: '', purpose: '', task: { ...c.task, id: '' },
    records: c.records.map(r => ({ ...r, id: '', supersedes: r.supersedes ? 'previous' : null })) }));
  assert.equal(new Set(signatures).size, 12);
  assert.deepEqual([...new Set(cases.map(c => c.task.family))].sort(), ['evidence', 'freshness', 'history']);
});
test('paired arms share all model-visible inputs except memory and cannot write to frozen memory', async () => {
  const c = evaluationCorpus()[0], before = canonical(c);
  const memory = new FrozenMemory(c.records);
  const off = await evaluateArm(c, deterministicModel, memory, false);
  const on = await evaluateArm(c, deterministicModel, memory, true);
  assert.equal(hash({ ...off.context, memories: [] }), hash({ ...on.context, memories: [] }));
  assert.deepEqual(Object.keys(on.context!).sort(), ['memories', 'offers', 'task']);
  assert.equal(JSON.stringify(on.context).includes('synthetic-type'), false);
  assert.equal(off.verdict, 'fail'); assert.equal(on.verdict, 'pass');
  assert.equal(canonical(c), before);
  await assert.rejects(memory.remember('text', 'key'), /EVALUATION_READ_ONLY/);
  await assert.rejects(memory.status('job'), /EVALUATION_READ_ONLY/);
});
test('the same-family overgeneralization remains visible as a higher demo cost', async () => {
  const c = evaluationCorpus()[1];
  const off = await evaluateArm(c, deterministicModel, new FrozenMemory(c.records), false);
  const on = await evaluateArm(c, deterministicModel, new FrozenMemory(c.records), true);
  assert.equal(off.verdict, 'pass'); assert.equal(on.verdict, 'pass');
  assert.equal(off.demoCredits, '1'); assert.equal(on.demoCredits, '2');
});
test('future and wrong-network records are excluded and a correction replaces the earlier failure', async () => {
  for (const name of ['freshness-future-record', 'freshness-wrong-network']) {
    const c = evaluationCorpus().find(c => c.id === name)!;
    const row = await evaluateArm(c, deterministicModel, new FrozenMemory(c.records), true);
    assert.deepEqual(row.memoryIdsAvailable, []);
    assert.equal(row.verdict, 'fail');
  }
  const corrected = evaluationCorpus().find(c => c.id === 'freshness-corrected-record')!;
  const row = await evaluateArm(corrected, deterministicModel, new FrozenMemory(corrected.records), true);
  assert.deepEqual(row.memoryIdsAvailable, ['correction:freshness']);
  assert.equal(row.selectedServiceId, 'atlas'); assert.equal(row.verdict, 'pass');
});
test('unknown versions and abstentions remain separate from verified successful results', async () => {
  const corpus = evaluationCorpus(); const rows = [];
  for (const name of ['history-version-uncertain', 'history-no-affordable-offer']) {
    const c = corpus.find(c => c.id === name)!;
    rows.push(await evaluateArm(c, deterministicModel, new FrozenMemory(c.records), false));
  }
  assert.deepEqual(rows.map(r => r.verdict), ['unknown', 'declined']);
  const summary = summarize(rows);
  assert.equal(summary.pass, 0); assert.equal(summary.demoCreditsPerPass, null);
});
test('malformed candidate output is recorded once with no repair or service call', async () => {
  const c = evaluationCorpus()[0]; let invocations = 0;
  const row = await evaluateArm(c, { mode: 'fixture', select: async () => { invocations++; return 'invalid JSON'; } }, new FrozenMemory(c.records), false);
  assert.equal(invocations, 1); assert.equal(row.verdict, 'error');
  assert.deepEqual(row.reasons, ['MODEL_JSON_INVALID']); assert.equal(row.serviceProjections, 0);
});
test('an unconfirmed pilot stops before creating a journal, reading Walrus or invoking a model', async () => {
  const { spawnSync } = await import('node:child_process');
  const file = new URL('../scripts/evaluate-pilot.ts', import.meta.url);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(file)], {
    env: { ...process.env, RECALL_EVAL_PILOT_CONFIRMED: 'false' }, encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.code, 'EVALUATION_NOT_CONFIRMED'); assert.equal(report.modelCallsThisInvocation, 0);
});
