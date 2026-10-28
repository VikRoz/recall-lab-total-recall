import type { Experience } from './domain.ts';
import type { EvaluationCase } from './evaluation.ts';

function base(id: string, family: string, purpose: string): EvaluationCase {
  const reference = { network: 'mainnet' as const, target: 'synthetic-object-A', version: '42',
    asOf: '2026-10-24T12:04:00.000Z', fields: { owner: 'synthetic-owner', objectType: 'synthetic-type' }, source: 'fixture' as const };
  const offers = ['atlas', 'beacon', 'cipher'].map((id, i) => ({ id, version: 'v1', network: 'mainnet' as const,
    families: ['evidence', 'freshness', 'history'], fields: ['owner', 'objectType'], price: String(i + 1) }));
  return { id, purpose, reference, offers,
    task: { id, network: 'mainnet', family, target: reference.target, requiredFields: ['owner', 'objectType'],
      maxAgeMs: 60000, budget: '3', cutoff: '2026-10-24T12:05:00.000Z' },
    results: offers.map(o => ({ ...structuredClone(reference), serviceId: o.id, serviceVersion: o.version })), records: [] };
}
function failure(c: EvaluationCase, reason: string): Experience {
  return { schema: 1, kind: 'experience', id: 'experience:' + c.id, network: 'mainnet', family: c.task.family,
    serviceId: 'atlas', serviceVersion: 'v1', recordedAt: '2026-10-24T12:01:00.000Z', observedAt: '2026-10-24T12:00:00.000Z',
    verdict: 'fail', reasons: [reason], supersedes: null,
    evidence: { source: 'fixture', target: c.task.target, version: '41' } };
}
function omitted(c: EvaluationCase) { delete c.results[0].fields.objectType; c.records = [failure(c, 'missing:objectType')]; return c; }
function historical(c: EvaluationCase) {
  c.reference.asOf = '2026-10-23T12:00:00.000Z'; c.task.maxAgeMs = 172800000;
  for (const r of c.results) r.asOf = c.reference.asOf;
  return c;
}
export function evaluationCorpus(): EvaluationCase[] {
  const e1 = omitted(base('evidence-known-failure', 'evidence', 'A hidden field omission can be avoided using prior experience.'));
  const e2 = omitted(base('evidence-field-not-required', 'evidence', 'Negative control: the omitted field is no longer required within the same family.'));
  e2.task.requiredFields = ['owner'];
  const e3 = omitted(base('evidence-repaired-version', 'evidence', 'An old v1 failure must not blacklist a healthy v2.'));
  e3.offers[0].version = 'v2'; e3.results[0] = { ...structuredClone(e3.reference), serviceId: 'atlas', serviceVersion: 'v2' };
  const e4 = omitted(base('evidence-budget-only-bad', 'evidence', 'Abstention when only the known failing service is affordable; not a valid-result pass.'));
  e4.task.budget = '1';

  const f1 = base('freshness-known-stale', 'freshness', 'A hidden stale response is outside the required time window.');
  f1.results[0].asOf = '2026-10-24T12:03:00.000Z'; f1.records = [failure(f1, 'outside-time-window')];
  const f2 = structuredClone(f1); f2.id = f2.task.id = 'freshness-future-record'; f2.purpose = 'Future recorded experience must not leak before the cutoff.';
  f2.records[0].recordedAt = '2026-10-24T12:06:00.000Z';
  const f3 = structuredClone(f1); f3.id = f3.task.id = 'freshness-wrong-network'; f3.purpose = 'A Testnet failure does not apply to Mainnet.';
  f3.records[0].network = 'testnet';
  const f4 = base('freshness-corrected-record', 'freshness', 'A complete same-scope correction permits the now-healthy service.');
  const old = failure(f4, 'outside-time-window');
  f4.records = [old, { ...old, id: 'correction:freshness', verdict: 'pass', reasons: [], supersedes: old.id,
    observedAt: '2026-10-24T12:02:00.000Z', recordedAt: '2026-10-24T12:02:00.000Z' }];

  const h1 = historical(base('history-other-family', 'history', 'A stale-for-freshness failure is not a ban on historical tasks.'));
  h1.records = [{ ...failure(h1, 'outside-time-window'), family: 'freshness' }];
  const h2 = historical(omitted(base('history-known-omission', 'history', 'Historical tasks still require complete requested evidence.')));
  const h3 = historical(base('history-version-uncertain', 'history', 'A different returned data version yields unknown, not a fabricated fact.'));
  h3.results[0].version = '43';
  const h4 = historical(base('history-no-affordable-offer', 'history', 'No compatible offer within budget results in abstention.'));
  h4.task.budget = '0';
  return [e1, e2, e3, e4, f1, f2, f3, f4, h1, h2, h3, h4];
}
