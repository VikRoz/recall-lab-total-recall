import test from 'node:test';
import assert from 'node:assert/strict';
import { cycle, observation } from '../src/agent.ts';
import { evaluationCorpus } from '../src/evaluation-corpus.ts';
import { evaluateArm, FrozenMemory, hash } from '../src/evaluation.ts';
import { buildEvaluationPlan, prospectiveCases } from '../src/evaluation-plan.ts';
import { knownFieldFailureIds, PROJECTION_POLICY } from '../src/projection-policy.ts';
import { fieldFailureRelevance } from '../src/field-failure.ts';
import type { Context, Offer } from '../src/domain.ts';
import type { EvaluationCase } from '../src/evaluation.ts';

const options = { projectionPolicy: PROJECTION_POLICY };
function harness(c: EvaluationCase, choose: (context: Context) => unknown = () => ({ serviceId: 'atlas', reason: 'adversarial fixture', memoryIds: [] })) {
  const calls = { model: 0, service: 0, reference: 0 }; let captured: Context | undefined;
  const memory = new FrozenMemory(c.records);
  const ports = { memory, serviceScope: 'controlled-demo-projection' as const,
    model: { mode: 'fixture' as const, select: async (context: Context) => { calls.model++; captured = structuredClone(context); return choose(context); } },
    service: async (offer: Offer) => { calls.service++; return structuredClone(c.results.find(r => r.serviceId === offer.id && r.serviceVersion === offer.version)!); },
    reference: async () => { calls.reference++; return structuredClone(c.reference); } };
  return { ports, calls, context: () => captured };
}
test('a known required field failure blocks the proposal before any service/reference, without model repair or forged citation', async () => {
  const c = evaluationCorpus()[0], h = harness(c);
  const result = await cycle(c.task, c.offers, h.ports, true, options);
  assert.equal(result.status, 'BLOCKED'); assert.deepEqual(h.calls, { model: 1, service: 0, reference: 0 });
  assert.equal(result.decision.serviceId, 'atlas'); assert.deepEqual(result.decision.memoryIds, []);
  assert.deepEqual('projectionPolicy' in result && result.projectionPolicy?.guardEvidenceIds, [c.records[0].id]);
  assert.throws(() => observation(c.task, result, '2026-10-24T12:06:00.000Z'), /NO_OBSERVATION/);
});
test('irrelevant failure is removed before the model and cannot force a more expensive service', async () => {
  const c = evaluationCorpus()[1], h = harness(c);
  const result = await cycle(c.task, c.offers, h.ports, true, options);
  assert.equal(result.status, 'VERIFIED'); assert.equal(h.calls.service, 1);
  assert.deepEqual(h.context()?.memories, []);
  assert.deepEqual('projectionPolicy' in result && result.projectionPolicy?.excludedAsIrrelevantIds, [c.records[0].id]);
});
test('mixed field failures retain required evidence and remove only the irrelevant record', async () => {
  const c = prospectiveCases()[0], h = harness(c, () => ({ serviceId: 'orion', reason: 'fixture valid alternative', memoryIds: [] }));
  const result = await cycle(c.task, c.offers, h.ports, true, options);
  assert.equal(result.status, 'VERIFIED');
  if (result.status === 'VERIFIED') assert.equal(result.verification.status, 'pass');
  assert.deepEqual(h.context()?.memories.map(e => e.serviceId), ['lyra']);
  assert.equal(h.calls.model, 1); assert.equal(h.calls.service, 1);
});
test('a model reference to a removed record is rejected, not silently repaired', async () => {
  const c = evaluationCorpus()[1], h = harness(c, () => ({ serviceId: 'atlas', reason: 'fixture stale reference', memoryIds: [c.records[0].id] }));
  await assert.rejects(cycle(c.task, c.offers, h.ports, true, options), /UNKNOWN_MEMORY_REFERENCE/);
  assert.equal(h.calls.service, 0); assert.equal(h.calls.model, 1);
});
test('the policy is opt-in and requires a controlled service declaration before memory/model effects', async () => {
  const c = evaluationCorpus()[0], h = harness(c);
  const legacy = await cycle(c.task, c.offers, h.ports, true);
  assert.equal(legacy.status, 'VERIFIED'); assert.equal('projectionPolicy' in legacy, false);
  if (legacy.status === 'VERIFIED') assert.equal(legacy.verification.status, 'fail');
  const missing = harness(c); delete (missing.ports as any).serviceScope;
  await assert.rejects(cycle(c.task, c.offers, missing.ports, true, options), /CONTROLLED_PROJECTION_SCOPE_REQUIRED/);
  assert.deepEqual(missing.calls, { model: 0, service: 0, reference: 0 });
  await assert.rejects(cycle(c.task, c.offers, harness(c).ports, true, { projectionPolicy: 'other' as any }), /PROJECTION_POLICY_INVALID/);
});
test('model mutations cannot alter the controller snapshot used by the guard', async () => {
  const c = evaluationCorpus()[0], before = structuredClone(c), h = harness(c, context => {
    context.memories.length = 0; context.task.requiredFields = ['owner'];
    return { serviceId: 'atlas', reason: 'mutating adversarial port', memoryIds: [] };
  });
  assert.equal((await cycle(c.task, c.offers, h.ports, true, options)).status, 'BLOCKED');
  assert.deepEqual(c, before); assert.equal(h.calls.service, 0);
});
test('full revision coverage is checked before irrelevant-field filtering or model selection', async () => {
  const c = evaluationCorpus()[1]; c.records.push({ ...c.records[0], id: 'correction', verdict: 'pass', reasons: [],
    supersedes: c.records[0].id, recordedAt: '2026-10-24T12:02:00.000Z' });
  const h = harness(c), recall = h.ports.memory.recall.bind(h.ports.memory);
  h.ports.memory.recall = async (q, n) => (await recall(q, n)).slice(0, 1);
  await assert.rejects(cycle(c.task, c.offers, h.ports, true, options), /MEMORY_CONTEXT_INCOMPLETE/);
  assert.equal(h.calls.model, 0);
});
test('a future correction cannot remove the guard; a visible correction permits the same version again', async () => {
  const c = evaluationCorpus()[0]; c.results[0] = { ...structuredClone(c.reference), serviceId: 'atlas', serviceVersion: 'v1' };
  c.records.push({ ...c.records[0], id: 'correction', verdict: 'pass', reasons: [], supersedes: c.records[0].id,
    recordedAt: '2026-10-24T12:02:00.000Z' });
  const before = structuredClone(c); before.task.cutoff = '2026-10-24T12:01:30.000Z';
  assert.equal((await cycle(before.task, before.offers, harness(before).ports, true, options)).status, 'BLOCKED');
  const after = harness(c), output = await cycle(c.task, c.offers, after.ports, true, options);
  assert.equal(output.status, 'VERIFIED'); assert.deepEqual(after.context()?.memories.map(e => e.id), ['correction']);
  if (output.status === 'VERIFIED') assert.equal(output.verification.status, 'pass');
});
test('new service versions, other networks/families and future records cannot trigger the guard', () => {
  const c = evaluationCorpus()[0], base = { task: c.task, offers: c.offers, memories: c.records };
  const proposal = { serviceId: 'atlas', reason: 'fixture', memoryIds: [] };
  for (const patch of [{ serviceVersion: 'v0' }, { network: 'testnet' }, { family: 'other' }, { recordedAt: '2026-10-24T13:00:00.000Z' }]) {
    const changed = structuredClone(base); Object.assign(changed.memories[0], patch);
    assert.deepEqual(knownFieldFailureIds(changed, proposal), []);
  }
  const repaired = evaluationCorpus()[2];
  assert.deepEqual(knownFieldFailureIds({ task: repaired.task, offers: repaired.offers, memories: repaired.records }, proposal), []);
});
test('unknown freshness conditions and mixed unknown reasons are preserved without an invented hard ban', async () => {
  const c = evaluationCorpus()[4], h = harness(c);
  assert.equal((await cycle(c.task, c.offers, h.ports, true, options)).status, 'VERIFIED');
  assert.equal(h.context()?.memories.length, 1); assert.equal(h.calls.service, 1);
  const mixed = evaluationCorpus()[1]; mixed.records[0].reasons.push('outside-time-window');
  assert.equal(fieldFailureRelevance(mixed.records[0], mixed.task), 'unassessable');
  const m = harness(mixed); await cycle(mixed.task, mixed.offers, m.ports, true, options);
  assert.equal(m.context()?.memories.length, 1); assert.equal(m.calls.service, 1);
});
test('memory-off and voluntary model decline retain their own distinct behavior', async () => {
  const c = evaluationCorpus()[0], off = harness(c); off.ports.memory.inventory = async () => { throw Error('must not read memory'); };
  const initial = await cycle(c.task, c.offers, off.ports, false, options);
  assert.equal(initial.status, 'VERIFIED'); assert.equal(off.calls.service, 1);
  const decline = harness(c, () => ({ serviceId: null, reason: 'fixture abstention', memoryIds: [] }));
  assert.equal((await cycle(c.task, c.offers, decline.ports, true, options)).status, 'DECLINED');
  assert.deepEqual(decline.calls, { model: 1, service: 0, reference: 0 });
});
test('policy evaluation distinguishes proposed and executed IDs and preserves the legacy frozen plan hash', async () => {
  const c = evaluationCorpus()[3], row = await evaluateArm(c, { mode: 'fixture', select: async () => ({
    serviceId: 'atlas', reason: 'fixture bad proposal', memoryIds: [] }) }, new FrozenMemory(c.records), true, options);
  assert.equal(row.verdict, 'declined'); assert.equal(row.executionStatus, 'BLOCKED');
  assert.equal(row.proposedServiceId, 'atlas'); assert.equal(row.selectedServiceId, null);
  assert.equal(row.demoCredits, '0'); assert.equal(row.serviceProjections, 0);
  assert.deepEqual(row.controllerEvidence?.guardEvidenceIds, [c.records[0].id]);
  assert.equal(hash(await buildEvaluationPlan()), '0cb4b6bfce29354a99f9bf3641f7cf29463df5f2690281aa85496c9174f36731');
});
