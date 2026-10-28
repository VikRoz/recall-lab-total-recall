// Offline rehearsal of saved public evidence. No provider, SQLite, HTTP or credential imports.
import { cycle, deterministicSelect, observation } from './agent.ts';
import { assert, canonical, decision, experience, time } from './domain.ts';
import type { Context, Experience, Offer, Result, Snapshot, Task } from './domain.ts';
import type { MemoryPort } from './memory.ts';
import { OLD_BLOB, OLD_RECORD, PLAN_HASH, correctionHash, correctionOffers, prepareCorrection, validateManifest } from './correction.ts';
import { PROJECTION_POLICY } from './projection-policy.ts';

export const REHEARSAL_INPUT_HASH = '89efc4d0a5ecbd614b3582b96252ac65b1e56af2cdb1119194310b5b2d969dac';
export const REHEARSAL_MODE = 'OFFLINE_REHEARSAL_RECORDED_REAL_EVIDENCE';
type SavedEffect = { id: string; kind: string; hash: string; state: string; response: string };
export type RehearsalEvidence = {
  schema: number; mode: string;
  stage0: { effects: Record<string, SavedEffect>; receipt: any; record: Experience };
  correction: { probe: ReturnType<typeof prepareCorrection> & { planHash: string }; 'reader-manifest': any; 'writer-result': any };
  historicalIndependentRead: any; originalIndependentRead: any; negativeModelPilot: any;
};
export function initialContext(e: RehearsalEvidence): Context {
  const source: Snapshot = JSON.parse(e.stage0.effects['stage0:tatum:source'].response);
  return { task: { id: 'stage0-smoke', network: 'mainnet', family: 'checkpoint', target: source.target,
    requiredFields: ['digest', 'sequenceNumber'], maxAgeMs: 600000, budget: '3', cutoff: source.asOf },
    offers: structuredClone(correctionOffers), memories: [] };
}
export function validateRehearsalEvidence(raw: unknown): RehearsalEvidence {
  assert(correctionHash(raw) === REHEARSAL_INPUT_HASH, 'REHEARSAL_EVIDENCE_CHANGED');
  const e = structuredClone(raw) as RehearsalEvidence;
  assert(e.schema === 1 && e.mode === 'RECORDED_REAL_EVIDENCE_NOT_LIVE', 'REHEARSAL_EVIDENCE_INVALID');
  const effects = e.stage0.effects, original = effects['stage0:tatum:source'], reference = effects['stage0:tatum:verify'];
  const model = effects['stage0:model:select'];
  assert([original, reference, model].every(x => x.state === 'DONE'), 'REHEARSAL_EFFECT_NOT_DONE');
  const source: Snapshot = JSON.parse(original.response), ref: Snapshot = JSON.parse(reference.response);
  assert(canonical(source) === canonical(ref) && source.source === 'tatum' && source.network === 'mainnet'
    && source.fields.sequenceNumber === source.version && source.target === 'checkpoint:' + source.version, 'REHEARSAL_SOURCE_INVALID');
  const context = initialContext(e);
  assert(correctionHash({ modelId: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', context }) === model.hash, 'REHEARSAL_MODEL_REQUEST_CHANGED');
  decision(JSON.parse(model.response), context);
  assert(correctionHash(experience(e.stage0.record)) === correctionHash(OLD_RECORD)
    && e.stage0.receipt.state === 'DONE' && e.stage0.receipt.blob_id === OLD_BLOB
    && e.stage0.receipt.hash === correctionHash(e.stage0.record), 'REHEARSAL_ORIGINAL_RECEIPT_INVALID');
  assert(e.originalIndependentRead.status === 'EXPECTED_BLOB_READ'
    && canonical(e.originalIndependentRead.records) === canonical([OLD_RECORD]), 'REHEARSAL_ORIGINAL_READ_INVALID');
  const p = e.correction.probe, manifest = e.correction['reader-manifest'], writer = e.correction['writer-result'];
  const replayed = prepareCorrection(p.source, p.reference, p.record.observedAt, p.record.recordedAt);
  const { planHash, ...savedProbe } = p;
  assert(planHash === PLAN_HASH && canonical(replayed) === canonical(savedProbe)
    && correctionHash(p.record) === manifest.recordHash, 'REHEARSAL_CORRECTION_PROOF_CHANGED');
  validateManifest(manifest);
  assert(writer.status === 'CORRECTION_WRITE_CONFIRMED_READER_NOT_RUN' && writer.receipt.state === 'done'
    && writer.receipt.blobId === manifest.correctionBlobId && writer.recordHash === manifest.recordHash, 'REHEARSAL_CORRECTION_RECEIPT_INVALID');
  const reader = e.historicalIndependentRead;
  assert(reader.status === 'CORRECTION_PORTABILITY_VERIFIED' && reader.memoryMode === 'live'
    && reader.namespaceRecords === 2 && reader.planHash === PLAN_HASH
    && reader.recalledRecordHashes.some((r: any) => r.id === p.record.id && r.hash === manifest.recordHash)
    && reader.recalledRecordHashes.some((r: any) => r.id === OLD_RECORD.id && r.hash === correctionHash(OLD_RECORD))
    && canonical(reader.beforeGuard) === canonical([OLD_RECORD.id]) && reader.afterGuard.length === 0, 'REHEARSAL_RECORDED_READER_INVALID');
  assert(e.negativeModelPilot.rows.length === 2 && e.negativeModelPilot.rows.every((r: any) => r.selector === 'model'
    && r.verdict === 'fail'), 'REHEARSAL_NEGATIVE_HISTORY_CHANGED');
  return e;
}

// This adapter replays the two exact saved records. It never claims a new live recall.
export class RehearsalMemory implements MemoryPort {
  mode = 'fixture' as const;
  rows: { blobId: string; record: Experience }[];
  constructor(e: RehearsalEvidence) {
    this.rows = structuredClone([{ blobId: OLD_BLOB, record: e.stage0.record },
      { blobId: e.correction['reader-manifest'].correctionBlobId, record: e.correction.probe.record }]);
  }
  async inventory() { return { blobIds: this.rows.map(r => r.blobId), revision: correctionHash(this.rows) }; }
  async recall(_query: string, limit: number) { return this.rows.slice(0, limit).map(r => ({ blobId: r.blobId, text: canonical(r.record) })); }
  async remember(): Promise<never> { throw new Error('REHEARSAL_WRITE_FORBIDDEN'); }
  async status(): Promise<never> { throw new Error('REHEARSAL_STATUS_FORBIDDEN'); }
}
// An explicit execution port for the owned projection. Repair never follows from a pass record alone.
export function recordedProjection(source: Snapshot, offer: Offer, repaired: boolean): Result {
  const fields = structuredClone(source.fields);
  if (offer.id === 'atlas' && !repaired) delete fields.digest;
  return { ...structuredClone(source), fields, serviceId: offer.id, serviceVersion: offer.version };
}
async function execute(e: RehearsalEvidence, task: Task, source: Snapshot, reference: Snapshot, repaired: boolean,
  useMemory: boolean, select: (context: Context) => unknown = deterministicSelect, legacy = false) {
  let serviceCalls = 0, referenceCalls = 0;
  const output = await cycle(task, correctionOffers, { memory: new RehearsalMemory(e), serviceScope: 'controlled-demo-projection',
    model: { mode: 'fixture', select: async context => select(context) },
    service: async offer => { serviceCalls++; return recordedProjection(source, offer, repaired); },
    reference: async () => { referenceCalls++; return structuredClone(reference); } }, useMemory,
    legacy ? {} : { projectionPolicy: PROJECTION_POLICY });
  return { output, serviceCalls, referenceCalls, sourceMode: 'SAVED_TATUM_SNAPSHOT',
    memoryMode: useMemory ? 'SAVED_WALRUS_RECORDS_LOCAL_ADAPTER' : 'off', selectorMode: 'LOCAL_OR_RECORDED_NO_MODEL_CALL' };
}
export async function runRehearsal(raw: unknown) {
  const e = validateRehearsalEvidence(raw), original = initialContext(e);
  const source: Snapshot = JSON.parse(e.stage0.effects['stage0:tatum:source'].response);
  const reference: Snapshot = JSON.parse(e.stage0.effects['stage0:tatum:verify'].response);
  const first = await execute(e, original.task, source, reference, false, false, context => {
    assert(canonical(context) === canonical(original), 'REHEARSAL_RECORDED_CONTEXT_CHANGED');
    return JSON.parse(e.stage0.effects['stage0:model:select'].response);
  }, true);
  assert(first.output.status === 'VERIFIED' && first.output.verification.status === 'fail'
    && canonical(observation(original.task, first.output, OLD_RECORD.recordedAt)) === canonical(OLD_RECORD), 'REHEARSAL_FIRST_FAILURE_CHANGED');
  const before: Task = { ...original.task, id: 'rehearsal-before-correction', cutoff: new Date(time(OLD_RECORD.recordedAt) + 1000).toISOString() };
  const remembered = await execute(e, before, source, reference, false, true);
  const baseline = await execute(e, before, source, reference, false, false);
  const blocked = await execute(e, before, source, reference, false, true, () => ({ serviceId: 'atlas', reason: 'Explicit adversarial control.', memoryIds: [] }));
  assert(remembered.output.status === 'VERIFIED' && remembered.output.decision.serviceId === 'beacon'
    && remembered.output.verification.status === 'pass', 'REHEARSAL_MEMORY_CONTROL_FAILED');
  assert(blocked.output.status === 'BLOCKED' && blocked.serviceCalls === 0 && blocked.referenceCalls === 0
    && blocked.output.decision.memoryIds.length === 0, 'REHEARSAL_GUARD_FAILED');
  const changedTask: Task = { ...before, id: 'rehearsal-sequence-only', requiredFields: ['sequenceNumber'] };
  const changed = await execute(e, changedTask, source, reference, false, true);
  assert(changed.output.status === 'VERIFIED' && changed.output.decision.serviceId === 'atlas'
    && changed.output.verification.status === 'pass' && changed.output.memoryIds.length === 0, 'REHEARSAL_FIELD_SCOPE_FAILED');
  const p = e.correction.probe;
  return { status: 'REHEARSAL_LOCAL_EPISODES_VERIFIED', mode: REHEARSAL_MODE, evidenceHash: REHEARSAL_INPUT_HASH,
    providerCalls: { tatum: 0, walrus: 0, model: 0 }, additionalSpendLimitUSD: 0, mainnetMemoriesAlreadyConfirmed: 2,
    episodes: [
      { id: 'first-failure', title: 'Исходный отказ', label: 'Сохранённый ответ LLM · локальный replay', task: original.task, ...first },
      { id: 'memory', title: 'Память меняет допуск и выбор', label: 'Локальный детерминированный контроль', task: before,
        ...remembered, withoutMemory: baseline, badProposal: blocked },
      { id: 'requirements', title: 'Требования меняются', label: 'Локальная проверка: нужен только sequenceNumber', task: changedTask, ...changed },
      { id: 'correction', title: 'Подтверждённое исправление', label: 'Сохранённая Mainnet-запись · повторная локальная проверка',
        record: p.record, receipt: e.correction['writer-result'].receipt, verification: p.verification, negativeControl: p.negativeControl,
        sourceMode: 'SAVED_TATUM_SNAPSHOT', timestamp: p.record.recordedAt },
    ],
    receipts: { original: e.stage0.receipt, correction: e.correction['writer-result'].receipt },
    recordedIndependentReader: { ...e.historicalIndependentRead, presentationMode: 'HISTORICAL_LIVE_RESULT_NOT_NEW_RECALL' },
    recordedModelCaveat: { title: 'Сохранённый 8B pilot: fail без памяти и с памятью.', ...e.negativeModelPilot },
    limitations: ['No new API calls, wallet transactions, memories or live model answers.',
      'Deterministic continuations are controls, not evidence of improved LLM reasoning.',
      'Historical cutoffs are frozen; no claim about current chain/service health.',
      'Same-account historical portability, not cross-account access.'] };
}
export async function runFreshRehearsal(raw: unknown) {
  const e = validateRehearsalEvidence(raw), p = e.correction.probe;
  const task = { ...p.task, id: 'rehearsal-new-process-after-correction' };
  const result = await execute(e, task, p.source, p.reference, true, true);
  assert(result.output.status === 'VERIFIED' && result.output.verification.status === 'pass'
    && result.output.decision.serviceId === 'atlas' && canonical(result.output.memoryIds) === canonical([p.record.id]), 'REHEARSAL_FRESH_PROCESS_FAILED');
  // A stale injected implementation must still fail even though the memory now contains a pass.
  const staleImplementation = await execute(e, task, p.source, p.reference, false, true);
  assert(staleImplementation.output.status === 'VERIFIED' && staleImplementation.output.verification.status === 'fail', 'REHEARSAL_PASS_MEMORY_MASKED_FAILURE');
  return { id: 'new-process', title: 'Новый процесс использует correction', label: 'Новый локальный процесс · replay сохранённой памяти',
    status: 'OFFLINE_NEW_PROCESS_REPLAY_VERIFIED', evidenceHash: REHEARSAL_INPUT_HASH, task, ...result,
    staleImplementationControl: { verdict: staleImplementation.output.verification.status, explanation: 'A pass record cannot repair an old broken execution port.' },
    providerCalls: { tatum: 0, walrus: 0, model: 0 } };
}
