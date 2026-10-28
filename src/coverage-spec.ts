import { assert, canonical, experience, scope, time, verify } from './domain.ts';
import type { Experience, Offer, Result, Snapshot, Task } from './domain.ts';
import { correctionHash as hash, OLD_BLOB, OLD_RECORD } from './correction.ts';
import { applicable, completeMemory } from './memory.ts';
import type { Hit, MemoryPort } from './memory.ts';
import { controlledMemory, knownFieldFailureIds } from './projection-policy.ts';
import { assessCitations } from './citations.ts';

export { hash };
export const COVERAGE_PLAN_HASH = '6d13e8a79d88c37fb5fbe10e73f0d35e64312e5e16253806b185391cf8cc7d6f';
export const ORDER_A = [3, 5, 7, 9], ORDER_B = [4, 6, 8, 10];
export const LIMITS = { tatum: 2, remember: 8, status: 64, inventory: 6, recall: 3 } as const;
export type Resource = keyof typeof LIMITS;
export type Clock = { now(): string; sleep(ms: number): Promise<void> };
export const BASE_EXPECTED = [
  { id: OLD_RECORD.id, blobId: OLD_BLOB, hash: hash(OLD_RECORD) },
  { id: 'experience:atlas-v1-correction-1', blobId: 'qpQxhrCw4zsgJm3UmZSUpwzotfOsEF6lcH3A2qyKRIE',
    hash: '29cb08f637671b0a6ce3ae0660048000ebe2ecb01c9368f0e62bb444e73ff671' },
];
export type Proof = { slot: number; operationKey: string; task: Task; offer: Offer; result: Result;
  reference: Snapshot; verification: ReturnType<typeof verify>; record: Experience; recordHash: string; ageMs: number };
export type Bundle = { mode: 'CONTROLLED_OPERATOR_PROOFS'; planHash: string; source: Snapshot; reference: Snapshot; proofs: Proof[] };
export type CoverageMode = 'OFFLINE_FIXTURE' | 'ADAPTER_DRY_RUN' | 'LIVE_MAINNET';
export type Manifest = { mode: CoverageMode; runPermitHash?: string; planHash: string; wave: 'preflight' | 'A' | 'B';
  entries: { id: string; blobId: string; hash: string }[] };
export function validatePlan(plan: unknown) { assert(hash(plan) === COVERAGE_PLAN_HASH, 'COVERAGE_PLAN_CHANGED'); }
function sourceValid(source: Snapshot) {
  assert(source.network === 'mainnet' && source.source === 'tatum' && /^(0|[1-9][0-9]*)$/.test(source.version)
    && source.target === 'checkpoint:' + source.version && source.fields.sequenceNumber === source.version
    && typeof source.fields.digest === 'string' && source.fields.digest.length > 0, 'COVERAGE_SOURCE_INVALID');
  time(source.asOf);
}
export async function buildBundle(plan: any, source: Snapshot, reference: Snapshot, clock: Clock): Promise<Bundle> {
  validatePlan(plan); sourceValid(source); sourceValid(reference);
  assert(canonical(source) === canonical(reference), 'COVERAGE_PINNED_MISMATCH');
  const proofs: Proof[] = []; let previous = -Infinity;
  for (const slot of [...ORDER_A, ...ORDER_B]) {
    if (proofs.length) await clock.sleep(1);
    const t = plan.recordTemplates.find((r: any) => r.slot === slot), now = clock.now(), ms = time(now);
    assert(ms > previous && ms >= time(source.asOf) && ms - time(source.asOf) <= 60000, 'COVERAGE_CLOCK_OR_FRESHNESS'); previous = ms;
    const offer: Offer = { id: t.serviceId, version: t.serviceVersion, network: 'mainnet', families: [t.family], fields: ['digest', 'sequenceNumber'], price: '1' };
    const task: Task = { id: 'coverage-v1-' + slot, network: 'mainnet', family: t.family, target: source.target,
      requiredFields: ['digest', 'sequenceNumber'], maxAgeMs: 60000, budget: '1', cutoff: now };
    const result: Result = { ...structuredClone(source), source: t.evidenceSource, serviceId: offer.id, serviceVersion: offer.version };
    const ref: Snapshot = { ...structuredClone(reference), source: t.evidenceSource };
    if (slot === 3) delete result.fields.sequenceNumber;
    if (slot === 5) result.fields.digest = 'demo-corrupted:' + source.fields.digest;
    if (slot === 7) result.asOf = new Date(ms - 121000).toISOString();
    if (slot === 9) ref.version = 'synthetic-unconfirmed-version';
    const verification = verify(task, offer, result, ref);
    assert(verification.status === t.expectedVerdict && canonical(verification.reasons) === canonical(t.expectedReasons), 'COVERAGE_UNEXPECTED_VERDICT');
    const recordedAt = clock.now(); assert(time(recordedAt) >= ms, 'COVERAGE_CLOCK_REGRESSED'); previous = time(recordedAt);
    const record = experience({ schema: 1, kind: 'experience', id: t.experienceId, network: 'mainnet', family: task.family,
      serviceId: offer.id, serviceVersion: offer.version, observedAt: now, recordedAt, verdict: verification.status,
      reasons: verification.reasons, supersedes: t.supersedes, evidence: { source: t.evidenceSource, target: task.target, version: result.version } });
    assert(Buffer.byteLength(canonical(record)) <= 4096 && scope(record) !== scope(OLD_RECORD), 'COVERAGE_RECORD_SCOPE_OR_SIZE');
    if (record.supersedes) {
      const parent = proofs.find(p => p.record.id === record.supersedes);
      assert(parent && scope(parent.record) === scope(record) && time(parent.record.recordedAt) < time(record.recordedAt), 'COVERAGE_PARENT_INVALID');
    }
    proofs.push({ slot, operationKey: t.operationKey, task, offer, result, reference: ref, verification, record,
      recordHash: hash(record), ageMs: time(task.cutoff) - time(result.asOf) });
  }
  return { mode: 'CONTROLLED_OPERATOR_PROOFS', planHash: COVERAGE_PLAN_HASH, source: structuredClone(source), reference: structuredClone(reference), proofs };
}
export function validateManifest(m: Manifest) {
  assert(['OFFLINE_FIXTURE', 'ADAPTER_DRY_RUN', 'LIVE_MAINNET'].includes(m.mode) && m.planHash === COVERAGE_PLAN_HASH
    && ['preflight', 'A', 'B'].includes(m.wave), 'COVERAGE_MANIFEST_INVALID');
  if (m.mode === 'LIVE_MAINNET') assert(typeof m.runPermitHash === 'string' && /^[a-f0-9]{64}$/.test(m.runPermitHash), 'COVERAGE_PERMIT_MISSING');
  else assert(m.runPermitHash === undefined, 'COVERAGE_UNEXPECTED_PERMIT');
  const slots = m.wave === 'preflight' ? [] : m.wave === 'A' ? ORDER_A : [...ORDER_A, ...ORDER_B];
  const expected = [...BASE_EXPECTED.map(e => e.id), ...slots.map(n => 'experience:coverage-v1:' + String(n).padStart(2, '0'))].sort();
  assert(Array.isArray(m.entries) && canonical(m.entries.map(e => e.id).sort()) === canonical(expected)
    && new Set(m.entries.map(e => e.blobId)).size === expected.length, 'COVERAGE_EXPECTED_SET_CHANGED');
  for (const e of m.entries) assert(typeof e.blobId === 'string' && e.blobId.length > 0 && /^[a-f0-9]{64}$/.test(e.hash), 'COVERAGE_MANIFEST_INVALID');
  for (const base of BASE_EXPECTED) assert(canonical(m.entries.find(e => e.id === base.id)) === canonical(base), 'COVERAGE_BASELINE_CHANGED');
}
export function assessRecords(m: Manifest, records: Experience[]) {
  validateManifest(m);
  assert(records.length === m.entries.length && new Set(records.map(e => e.id)).size === records.length, 'COVERAGE_RECORD_SET_CHANGED');
  for (const entry of m.entries) assert(records.some(r => r.id === entry.id && hash(experience(r)) === entry.hash), 'COVERAGE_RECORD_HASH_CHANGED');
  const policyChecks: any[] = [];
  for (const slot of ORDER_A) {
    const old = records.find(e => e.id === 'experience:coverage-v1:' + String(slot).padStart(2, '0'));
    if (!old) continue;
    const correction = records.find(e => e.supersedes === old.id);
    const offer: Offer = { id: old.serviceId, version: old.serviceVersion, network: 'mainnet', families: [old.family], fields: ['digest', 'sequenceNumber'], price: '1' };
    const task: Task = { id: 'coverage-reader-' + slot, network: 'mainnet', family: old.family, target: old.evidence.target,
      requiredFields: ['digest', 'sequenceNumber'], maxAgeMs: 60000, budget: '1', cutoff: old.recordedAt };
    const before = applicable(records, task, [offer]);
    assert(canonical(before.map(e => e.id)) === canonical([old.id]), 'COVERAGE_FUTURE_CORRECTION_LEAK');
    const proposal = { serviceId: old.serviceId, reason: 'Admission check, not a model claim.', memoryIds: [] };
    const guard = knownFieldFailureIds({ task, offers: [offer], memories: before }, proposal);
    assert(guard.length === (slot < 7 ? 1 : 0), 'COVERAGE_GUARD_SEMANTICS');
    if (slot < 7) {
      const narrow = { ...task, requiredFields: [slot === 3 ? 'digest' : 'sequenceNumber'] };
      assert(controlledMemory(narrow, applicable(records, narrow, [offer])).memories.length === 0, 'COVERAGE_FIELD_FILTER');
    } else assert(assessCitations({ task, offers: [offer], memories: before }, { ...proposal, memoryIds: [old.id] }).status === 'unverifiable', 'COVERAGE_UNCERTAINTY_HIDDEN');
    if (m.wave === 'B') {
      assert(correction && correction.verdict === 'pass' && correction.reasons.length === 0 && scope(correction) === scope(old), 'COVERAGE_CORRECTION_MISSING');
      const afterTask = { ...task, cutoff: correction.recordedAt }, after = applicable(records, afterTask, [offer]);
      assert(canonical(after.map(e => e.id)) === canonical([correction.id])
        && knownFieldFailureIds({ task: afterTask, offers: [offer], memories: after }, proposal).length === 0, 'COVERAGE_CORRECTION_NOT_ACTIVE');
    }
    policyChecks.push({ slot, beforeActive: old.id, beforeGuard: guard, afterActive: correction?.id ?? null });
  }
  return { wave: m.wave, manifestHash: hash(m), records: structuredClone(records), policyChecks,
    status: m.mode === 'OFFLINE_FIXTURE' ? 'OFFLINE_READ_VERIFIED' : m.mode === 'ADAPTER_DRY_RUN' ? 'ADAPTER_DRY_READ_VERIFIED' : 'PROVIDER_READ_VERIFIED' };
}
export async function readCoverage(memory: MemoryPort, m: Manifest) {
  validateManifest(m); assert(memory.mode === (m.mode === 'OFFLINE_FIXTURE' ? 'fixture' : 'live'), 'COVERAGE_ADAPTER_MODE_MISMATCH');
  let inventory = 0, recall = 0; const actual: Hit[] = [];
  const records = await completeMemory({ mode: memory.mode, inventory: () => { assert(++inventory <= 2, 'COVERAGE_READER_LIMIT'); return memory.inventory(); },
    recall: async (q, n) => { assert(++recall <= 1, 'COVERAGE_READER_LIMIT'); const hits = await memory.recall(q, n);
      for (const hit of hits) {
        assert(Buffer.byteLength(hit.text) <= 4096, 'MEMORY_RECORD_TOO_LARGE');
        const r = experience(JSON.parse(hit.text)), expected = m.entries.find(e => e.blobId === hit.blobId);
        assert(expected && expected.id === r.id && expected.hash === hash(r), 'COVERAGE_BLOB_CONTENT_CHANGED');
      }
      actual.push(...structuredClone(hits)); return hits; },
    remember: async () => { throw Error('COVERAGE_READER_WRITE_FORBIDDEN'); }, status: async () => { throw Error('COVERAGE_READER_STATUS_FORBIDDEN'); } }, m.entries.map(e => e.blobId));
  return { ...assessRecords(m, records), inventoryCalls: inventory, recallCalls: recall, hits: actual };
}
