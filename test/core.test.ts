import test from 'node:test';
import assert from 'node:assert/strict';
import { cycle, observation, deterministicSelect } from '../src/agent.ts';
import { applicable, completeMemory } from '../src/memory.ts';
import { canonical, decision, verify } from '../src/domain.ts';
import { offers, task, reference, service, FixtureMemory, FixtureModel, newBacking } from '../src/fixtures.ts';
import { runDemo } from '../scripts/demo.ts';
import type { Experience } from '../src/domain.ts';

async function record(): Promise<Experience> {
  const t = task('observed');
  const output = await cycle(t, offers, { memory: new FixtureMemory(), model: new FixtureModel(), service, reference: async () => reference(t) }, false);
  return observation(t, output, '2026-10-24T12:00:01.000Z');
}
test('fresh sessions use a scoped failure, changing task and version removes its applicability', async () => {
  const d = await runDemo();
  assert.equal(d.mode, 'DETERMINISTIC_FIXTURE');
  assert.deepEqual(d.episodes.map(e => e.output.decision.serviceId), ['atlas', 'beacon', 'atlas', 'atlas', 'atlas']);
  assert.deepEqual(d.episodes.map(e => e.output.status === 'VERIFIED' ? e.output.verification.status : ''), ['fail', 'pass', 'fail', 'pass', 'pass']);
  assert.equal(d.modelCalls, 0); assert.equal(d.mainnetWrites, 0);
  assert.equal(d.episodes[3].task.family, d.episodes[1].task.family);
  assert.deepEqual(d.episodes[3].task.requiredFields, ['owner']);
  assert.deepEqual('projectionPolicy' in d.episodes[3].output && d.episodes[3].output.projectionPolicy?.excludedAsIrrelevantIds,
    ['experience:first']);
});
test('omitted newest correction makes memory incomplete rather than reviving the older failure', async () => {
  const memory = new FixtureMemory(); const first = await record();
  await memory.seed(first);
  await memory.seed({ ...first, id: 'correction', supersedes: first.id, recordedAt: '2026-10-24T12:01:00.000Z', verdict: 'pass', reasons: [] });
  const original = memory.recall.bind(memory);
  memory.recall = async (q, n) => (await original(q, n)).slice(0, 1);
  await assert.rejects(() => completeMemory(memory), /MEMORY_CONTEXT_INCOMPLETE/);
});
test('a later correction replaces the superseded conclusion, but only after its cutoff', async () => {
  const memory = new FixtureMemory(); const first = await record();
  await memory.seed(first);
  await memory.seed({ ...first, id: 'correction', supersedes: first.id, recordedAt: '2026-10-24T12:02:00.000Z', verdict: 'pass', reasons: [] });
  const records = await completeMemory(memory);
  assert.equal(applicable(records, task('before', 'evidence', '2026-10-24T12:01:00.000Z'), offers)[0].verdict, 'fail');
  assert.equal(applicable(records, task('after', 'evidence', '2026-10-24T12:03:00.000Z'), offers)[0].verdict, 'pass');
});
test('revision chains cannot refer to an absent or differently scoped predecessor', async () => {
  const memory = new FixtureMemory(); const first = await record();
  await memory.seed({ ...first, supersedes: 'missing' });
  await assert.rejects(() => completeMemory(memory), /MEMORY_REVISION_INVALID/);
});
test('equal-time conflicting outcomes cannot silently pick one', async () => {
  const first = await record();
  assert.throws(() => applicable([first, { ...first, id: 'other', verdict: 'pass' }], task('later', 'evidence', '2026-10-24T12:01:00.000Z'), offers), /MEMORY_CONFLICT/);
});
test('unknown memory fields cannot become instructions', async () => {
  const memory = new FixtureMemory();
  await memory.seed({ ...await record(), tool: 'send-money' });
  await assert.rejects(() => completeMemory(memory), /INVALID_KEYS/);
});
test('inconsistent inventory stops before calling the model', async () => {
  const memory = new FixtureMemory(); let n = 0, modelCalls = 0;
  memory.inventory = async () => ({ blobIds: [], revision: String(n++) });
  await assert.rejects(() => cycle(task('unstable'), offers, { memory, model: { mode: 'fixture', select: async () => { modelCalls++; } }, service, reference: async () => reference(task('unstable')) }, true), /MEMORY_CHANGED_DURING_READ/);
  assert.equal(modelCalls, 0);
});
test('wrong network, missing fields and unpinned comparisons have different outcomes', async () => {
  const t = task('facts'); const r = { ...reference(t), serviceId: 'beacon', serviceVersion: 'v1' };
  assert.equal(verify(t, offers[1], { ...r, network: 'testnet' }, reference(t)).status, 'fail');
  assert.equal(verify(t, offers[1], { ...r, version: '43' }, reference(t)).status, 'unknown');
  assert.equal(verify(t, offers[1], { ...r, fields: { owner: 'synthetic-owner' } }, reference(t)).status, 'fail');
});
test('large integer prices are compared without float rounding', () => {
  const t = { ...task('large'), budget: '9007199254740993' };
  const catalog = [{ ...offers[0], price: '9007199254740993' }, { ...offers[1], price: '9007199254740992' }];
  assert.equal(deterministicSelect({ task: t, offers: catalog, memories: [] }).serviceId, 'beacon');
});
test('invalid model actions never reach a service, and references are absent from its context', async () => {
  let serviceCalls = 0, modelCalls = 0;
  await assert.rejects(() => cycle(task('blocked'), offers, {
    memory: new FixtureMemory(), model: { mode: 'fixture', select: async context => {
      modelCalls++; assert.deepEqual(Object.keys(context).sort(), ['memories', 'offers', 'task']);
      assert.equal(JSON.stringify(context).includes('synthetic-owner'), false);
      return { serviceId: 'external-url', reason: 'x', memoryIds: [] };
    } }, service: async () => { serviceCalls++; throw new Error(); }, reference: async () => { throw new Error(); },
  }, false), /ACTION_BLOCKED/);
  assert.equal(serviceCalls, 0); assert.equal(modelCalls, 1);
});
test('model cannot cite unseen memories or add arbitrary actions', () => {
  const context = { task: task('refs'), offers, memories: [] };
  assert.throws(() => decision({ serviceId: 'atlas', reason: 'x', memoryIds: ['invented'] }, context), /UNKNOWN_MEMORY_REFERENCE/);
  assert.throws(() => decision({ serviceId: 'atlas', reason: 'x', memoryIds: [], execute: 'x' }, context), /INVALID_KEYS/);
});
test('wrong-network memory and future experience are not provided to the model', async () => {
  const e = await record();
  assert.deepEqual(applicable([{ ...e, network: 'testnet' }], task('a', 'evidence', '2026-10-24T12:01:00.000Z'), offers), []);
  assert.deepEqual(applicable([e], task('b'), offers), []);
});
test('fixture idempotency matches payload, not merely the supplied key', async () => {
  const memory = new FixtureMemory(newBacking()); const payload = canonical(await record());
  const first = await memory.remember(payload, 'same');
  assert.deepEqual(await memory.remember(payload, 'same'), first);
  await assert.rejects(() => memory.remember(payload + ' ', 'same'), /IDEMPOTENCY_CONFLICT/);
});
test('an empty relayer index does not erase knowledge of an expected durable write', async () => {
  await assert.rejects(() => completeMemory(new FixtureMemory(), ['known-blob']), /MEMORY_EXPECTED_RECORD_MISSING/);
});
