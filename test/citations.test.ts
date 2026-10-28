import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCitations, auditEvaluationReport } from '../src/citations.ts';
import { evaluationCorpus } from '../src/evaluation-corpus.ts';
import { cycle } from '../src/agent.ts';
import { FrozenMemory } from '../src/evaluation.ts';
import type { Context } from '../src/domain.ts';

function context(index = 0): Context {
  const c = evaluationCorpus()[index];
  return { task: c.task, offers: c.offers, memories: c.records };
}
const choose = (c: Context, serviceId: string | null = 'beacon', cite = true) => ({
  serviceId, reason: 'synthetic test decision', memoryIds: cite ? [c.memories[0].id] : [],
});
test('a cited failure may support avoiding an unchosen offer, without rewriting the decision', () => {
  const c = context(), d = choose(c), before = structuredClone({ c, d });
  const audit = assessCitations(c, d);
  assert.equal(audit.status, 'supported'); assert.equal(audit.citationGatePassed, true);
  assert.deepEqual(audit.declaredMemoryIds, [c.memories[0].id]);
  assert.deepEqual({ c, d }, before);
});
test('delivered memory is not a model citation; empty references stay empty', () => {
  const c = context(), d = choose(c, 'beacon', false);
  const a = assessCitations(c, d);
  assert.equal(a.status, 'not_declared'); assert.equal(a.citationGatePassed, false);
  assert.equal(a.providedMemoryIds.length, 1); assert.deepEqual(a.declaredMemoryIds, []);
  const off = { ...c, memories: [] };
  assert.equal(assessCitations(off, d).status, 'none_available');
});
test('a real ID does not validate a contradictory action or an irrelevant failed field', () => {
  const c = context();
  assert.equal(assessCitations(c, choose(c, 'atlas')).status, 'contradicted');
  const changed = context(1);
  assert.equal(assessCitations(changed, choose(changed)).status, 'irrelevant');
});
test('unseen, duplicate and malformed references still fail the existing schema', () => {
  const c = context();
  assert.throws(() => assessCitations(c, { ...choose(c), memoryIds: ['invented'] }), /UNKNOWN_MEMORY_REFERENCE/);
  assert.throws(() => assessCitations(c, { ...choose(c), memoryIds: [c.memories[0].id, c.memories[0].id] }), /MODEL_INVALID/);
  assert.throws(() => assessCitations(c, { ...choose(c), extra: true }), /INVALID_KEYS/);
  assert.throws(() => assessCitations({ ...c, memories: [c.memories[0], c.memories[0]] }, choose(c)), /CITATION_CONTEXT_INVALID/);
});
test('network, family, version, future time and unaffordable candidates cannot support a claim', () => {
  const c = context();
  for (const patch of [{ network: 'testnet' }, { family: 'other' }, { serviceVersion: 'v0' },
    { recordedAt: '2026-10-24T13:00:00.000Z' }]) {
    const changed = structuredClone(c); Object.assign(changed.memories[0], patch);
    assert.equal(assessCitations(changed, choose(changed)).status, 'inapplicable');
  }
  const expensive = structuredClone(c); expensive.offers[0].price = '4';
  assert.equal(assessCitations(expensive, choose(expensive)).status, 'inapplicable');
});
test('superseded evidence is not revived and unknown freshness thresholds are not invented', () => {
  const c = context();
  c.memories.push({ ...c.memories[0], id: 'correction', recordedAt: '2026-10-24T12:02:00.000Z',
    supersedes: c.memories[0].id, verdict: 'pass', reasons: [] });
  assert.equal(assessCitations(c, choose(c)).status, 'inapplicable');
  const freshness = context(); freshness.memories[0].reasons = ['outside-time-window'];
  assert.equal(assessCitations(freshness, choose(freshness)).status, 'unverifiable');
});
test('citation failure does not block an otherwise admissible action or manufacture a service result', async () => {
  const c = evaluationCorpus()[0]; let serviceCalls = 0;
  const output = await cycle(c.task, c.offers, { memory: new FrozenMemory(c.records), model: {
    mode: 'fixture', select: async current => choose(current, 'beacon', false),
  }, service: async offer => { serviceCalls++; return c.results.find(r => r.serviceId === offer.id)!; },
  reference: async () => c.reference }, true);
  assert.equal(serviceCalls, 1); assert.equal(output.status, 'VERIFIED');
  if (output.status === 'VERIFIED') assert.equal(output.verification.status, 'pass');
  assert.equal(assessCitations(context(), output.decision).status, 'not_declared');
});
test('retrospective audit separates verifier success and citation support without altering historical scores', () => {
  const c = context(), source = { status: 'HISTORICAL', rows: [{ selector: 'model', caseId: c.task.id,
    context: c, decision: choose(c, 'beacon', false), memoryEnabled: true, selectedServiceId: 'beacon', verdict: 'pass' }] };
  const original = structuredClone(source), report = auditEvaluationReport(source);
  assert.equal(report.rows[0].verifier, 'pass'); assert.equal(report.rows[0].audit?.status, 'not_declared');
  assert.equal(report.newModelCalls, 0); assert.equal(report.retrospective, true); assert.deepEqual(source, original);
});
