// Explicit operator protocol for the owned Atlas projection. Not a new agent admission policy.
import { assert, canonical, decision, experience, time, validateTask, verify } from './domain.ts';
import type { Context, Experience, Offer, Snapshot, Task } from './domain.ts';
import { applicable, completeMemory } from './memory.ts';
import type { MemoryPort } from './memory.ts';
import { controlledMemory, knownFieldFailureIds } from './projection-policy.ts';
import { deterministicSelect } from './agent.ts';
import { createHash } from 'node:crypto';

export const correctionHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const OLD_BLOB = 'DiyAqT9ArzQxgIpjGRy8wh7euL3MdOeJInmswZAGfvM';
export const OLD_RECORD: Experience = {
  schema: 1, kind: 'experience', id: 'experience:stage0-smoke', network: 'mainnet', family: 'checkpoint',
  serviceId: 'atlas', serviceVersion: 'v1', recordedAt: '2026-10-26T14:47:58.112Z', observedAt: '2026-10-26T14:47:56.743Z',
  verdict: 'fail', reasons: ['missing:digest'], supersedes: null,
  evidence: { source: 'tatum', target: 'checkpoint:338359837', version: '338359837' },
};
export const CORRECTION_ID = 'experience:atlas-v1-correction-1';
export const WRITE_KEY = 'correction:v1:experience:1';
export const CORRECTION_PLAN = {
  protocol: 'atlas-correction-portability-v1', additionalSpendLimitUSD: 0,
  scope: 'CONTROLLED_DEMO_PROJECTION_ONLY', namespace: 'total-recall-stage0',
  oldBlobId: OLD_BLOB, oldRecordHash: correctionHash(OLD_RECORD), correctionId: CORRECTION_ID, writeKey: WRITE_KEY,
  maximums: { tatumReads: 2, modelCalls: 0, rememberSubmissions: 1, statusReads: 8,
    writerRecallCycles: 1, independentRecallCycles: 1, inventoryPagesPerCall: 8, records: 20, recordBytes: 4096 },
  statusIntervalMs: 5000, maxSourceAgeMs: 600000,
  noAutomaticRetry: true, noPaidFallback: true, noWalletTransaction: true,
  freshReader: 'separate-process-no-journal-no-probe-payload',
};
export const PLAN_HASH = correctionHash(CORRECTION_PLAN);
export const correctionOffers: Offer[] = ['atlas', 'beacon', 'cipher'].map((id, i) => ({ id, version: 'v1',
  network: 'mainnet', families: ['checkpoint'], fields: ['digest', 'sequenceNumber'], price: String(i + 1) }));
export function correctionTask(source: Snapshot, cutoff: string): Task {
  const task: Task = { id: 'atlas-v1-correction-1', network: 'mainnet', family: 'checkpoint', target: source.target,
    requiredFields: ['digest', 'sequenceNumber'], maxAgeMs: CORRECTION_PLAN.maxSourceAgeMs, budget: '3', cutoff };
  validateTask(task); return task;
}
export function checkOld(records: Experience[]) {
  assert(records.length === 1 && correctionHash(records[0]) === CORRECTION_PLAN.oldRecordHash, 'CORRECTION_BASELINE_CHANGED');
}
function checkSnapshot(s: Snapshot) {
  assert(s.network === 'mainnet' && s.source === 'tatum' && /^(0|[1-9][0-9]*)$/.test(s.version)
    && s.target === 'checkpoint:' + s.version && s.fields.sequenceNumber === s.version
    && typeof s.fields.digest === 'string' && s.fields.digest.length > 0, 'CORRECTION_SOURCE_INVALID');
  time(s.asOf);
}
export function prepareCorrection(source: Snapshot, reference: Snapshot, observedAt: string, recordedAt: string) {
  checkSnapshot(source); checkSnapshot(reference);
  assert(correctionHash(source) === correctionHash(reference), 'CORRECTION_REFERENCE_CHANGED');
  assert(time(recordedAt) >= time(observedAt) && time(observedAt) > time(OLD_RECORD.recordedAt), 'CORRECTION_TIME_INVALID');
  const task = correctionTask(source, observedAt), offer = correctionOffers[0];
  const result = { ...structuredClone(source), serviceId: offer.id, serviceVersion: offer.version };
  const broken = structuredClone(result); delete broken.fields.digest;
  const negativeControl = verify(task, offer, broken, reference), verification = verify(task, offer, result, reference);
  assert(negativeControl.status === 'fail' && canonical(negativeControl.reasons) === canonical(['missing:digest']), 'CORRECTION_NEGATIVE_CONTROL_FAILED');
  assert(verification.status === 'pass' && verification.reasons.length === 0, 'CORRECTION_PROBE_FAILED');
  // The operator deliberately verifies the repaired owned projection; no agent guard is bypassed.
  const record = experience({ schema: 1, kind: 'experience', id: CORRECTION_ID, network: 'mainnet', family: 'checkpoint',
    serviceId: 'atlas', serviceVersion: 'v1', observedAt, recordedAt, verdict: 'pass', reasons: [], supersedes: OLD_RECORD.id,
    evidence: { source: 'tatum', target: source.target, version: source.version } });
  assert(Buffer.byteLength(canonical(record)) <= CORRECTION_PLAN.maximums.recordBytes, 'CORRECTION_RECORD_TOO_LARGE');
  const context: Context = { task, offers: correctionOffers, memories: [OLD_RECORD] };
  const proposal = { serviceId: 'atlas', reason: 'Operator admission check; not a model inference.', memoryIds: [] };
  assert(canonical(knownFieldFailureIds(context, proposal)) === canonical([OLD_RECORD.id]), 'CORRECTION_OLD_GUARD_MISSING');
  return { task, source, reference, result, negativeControl, verification, record,
    disclosure: 'Owned synthetic service projection of real Tatum data; the digest omission is explicitly removed. Not an external merchant repair.',
    operatorProbe: true, agentServiceCalls: 0, modelCalls: 0, recordHash: correctionHash(record) };
}
export type ReaderManifest = { protocol: string; planHash: string; oldBlobId: string; correctionBlobId: string;
  correctionId: string; recordHash: string; task: Task; correctionRecordedAt: string };
export function validateManifest(m: ReaderManifest) {
  assert(m.protocol === CORRECTION_PLAN.protocol && m.planHash === PLAN_HASH && m.oldBlobId === OLD_BLOB
    && m.correctionId === CORRECTION_ID && typeof m.correctionBlobId === 'string' && m.correctionBlobId.length > 0
    && m.correctionBlobId !== OLD_BLOB && /^[a-f0-9]{64}$/.test(m.recordHash), 'CORRECTION_MANIFEST_INVALID');
  validateTask(m.task); time(m.correctionRecordedAt);
  assert(correctionHash(m.task) === correctionHash(correctionTask({ target: m.task.target } as Snapshot, m.task.cutoff))
    && time(m.task.cutoff) === time(m.correctionRecordedAt), 'CORRECTION_MANIFEST_TASK_INVALID');
}
export async function verifyIndependentCorrection(memory: MemoryPort, manifest: ReaderManifest) {
  validateManifest(manifest);
  const expected = new Map([[manifest.oldBlobId, CORRECTION_PLAN.oldRecordHash], [manifest.correctionBlobId, manifest.recordHash]]);
  const checked: MemoryPort = { mode: memory.mode, inventory: () => memory.inventory(),
    remember: async () => { throw new Error('READER_WRITE_FORBIDDEN'); },
    status: async () => { throw new Error('READER_STATUS_FORBIDDEN'); },
    recall: async (query, limit) => {
      const hits = await memory.recall(query, limit);
      for (const hit of hits) {
        assert(Buffer.byteLength(hit.text) <= CORRECTION_PLAN.maximums.recordBytes, 'MEMORY_RECORD_TOO_LARGE');
        assert(expected.has(hit.blobId) && correctionHash(JSON.parse(hit.text)) === expected.get(hit.blobId), 'CORRECTION_BLOB_CONTENT_MISMATCH');
      }
      return hits;
    } };
  const records = await completeMemory(checked, [manifest.oldBlobId, manifest.correctionBlobId]);
  assert(records.length === 2, 'CORRECTION_NAMESPACE_CHANGED');
  const old = records.find(e => e.id === OLD_RECORD.id), correction = records.find(e => e.id === CORRECTION_ID);
  assert(old && correctionHash(old) === CORRECTION_PLAN.oldRecordHash, 'CORRECTION_OLD_CONTENT_CHANGED');
  assert(correction && correctionHash(correction) === manifest.recordHash && correction.verdict === 'pass'
    && correction.reasons.length === 0 && correction.supersedes === old.id
    && correction.recordedAt === manifest.correctionRecordedAt
    && correction.evidence.source === 'tatum' && correction.evidence.target === manifest.task.target
    && correction.evidence.target === 'checkpoint:' + correction.evidence.version, 'CORRECTION_CONTENT_MISMATCH');
  const beforeTask = { ...manifest.task, cutoff: OLD_RECORD.recordedAt };
  const before = controlledMemory(beforeTask, applicable(records, beforeTask, correctionOffers));
  const after = controlledMemory(manifest.task, applicable(records, manifest.task, correctionOffers));
  assert(canonical(before.memories.map(e => e.id)) === canonical([old.id]), 'CORRECTION_PAST_CHANGED');
  assert(canonical(after.memories.map(e => e.id)) === canonical([correction.id]), 'CORRECTION_NOT_ACTIVE');
  const proposal = { serviceId: 'atlas', reason: 'Deterministic admission probe; not a language model.', memoryIds: [] };
  const beforeGuard = knownFieldFailureIds({ task: beforeTask, offers: correctionOffers, memories: before.memories }, proposal);
  const afterContext = { task: manifest.task, offers: correctionOffers, memories: after.memories };
  const afterGuard = knownFieldFailureIds(afterContext, proposal);
  assert(canonical(beforeGuard) === canonical([old.id]) && afterGuard.length === 0, 'CORRECTION_GUARD_CONTINUITY_FAILED');
  const selected = decision(deterministicSelect(afterContext), afterContext);
  assert(selected.serviceId === 'atlas', 'CORRECTION_SELECTION_FAILED');
  return { status: 'CORRECTION_PORTABILITY_VERIFIED', memoryMode: memory.mode, planHash: PLAN_HASH,
    namespaceRecords: records.length, recalledRecordHashes: records.map(e => ({ id: e.id, hash: correctionHash(e) })),
    beforeGuard, afterGuard, activeMemoryIds: after.memories.map(e => e.id), deterministicDecision: selected,
    modelCalls: 0, serviceCalls: 0, independentOfWriterJournal: true,
    limitation: 'Same account/delegate, new process. No cross-account authorization, LLM quality or permanent external service health claim.' };
}
