// Offline computations over the exact saved public live export. No provider/SQLite imports.
import { assert, canonical, experience, time, verify } from './domain.ts';
import type { Experience } from './domain.ts';
import type { MemoryPort } from './memory.ts';
import { cycle, deterministicSelect } from './agent.ts';
import { assessRecords, BASE_EXPECTED, hash, LIMITS, ORDER_A, ORDER_B } from './coverage-spec.ts';
import { PROJECTION_POLICY } from './projection-policy.ts';
import { validateRehearsalEvidence, REHEARSAL_INPUT_HASH } from './rehearsal.ts';

export const COVERAGE_REHEARSAL_HASH = '92f3fd8103b9fe0fb784af07c88b10fad8b3091a6d7eb5e06345fe5f5c954f0f';
export const COVERAGE_RUN_HASH = 'bd030c1f107ee3c848f91148378b45965a8c1f9ac382105139f350f28fda37eb';
export function validateCoverageRehearsal(raw: unknown) {
  assert(hash(raw) === COVERAGE_REHEARSAL_HASH, 'REHEARSAL_COVERAGE_EVIDENCE_CHANGED');
  const e: any = structuredClone(raw);
  assert(e.run.state === 'DONE' && e.result.status === 'COVERAGE_MAINNET_COMPLETED'
    && e.result.confirmedRecords === 10 && e.result.confirmedNewWrites === 8
    && hash(e.runPermit) === COVERAGE_RUN_HASH && e.result.additionalSpendLimitUSD === 0,
  'REHEARSAL_COVERAGE_NOT_COMPLETE');
  assert(hash(e.bundle) === e.result.frozenBundleHash && e.bundle.proofs.length === 8
    && canonical(e.bundle.source) === canonical(e.bundle.reference), 'REHEARSAL_COVERAGE_BUNDLE_INVALID');
  assert(e.effects.length === 2 && e.effects.every((x: any) => x.state === 'DONE'
    && canonical(x.response) === canonical(e.bundle.source)), 'REHEARSAL_COVERAGE_SOURCE_INVALID');
  assert(canonical(e.outbox) === canonical(e.result.perJob) && e.outbox.length === 8,
    'REHEARSAL_COVERAGE_RECEIPTS_INVALID');
  for (const slot of [...ORDER_A, ...ORDER_B]) {
    const p = e.bundle.proofs.find((x: any) => x.slot === slot);
    const receipt = e.outbox.find((x: any) => x.slot === slot);
    assert(p && receipt?.state === 'DONE' && receipt.blob_id && receipt.job_id
      && receipt.operation_key === p.operationKey && receipt.hash === p.recordHash
      && hash(experience(p.record)) === p.recordHash, 'REHEARSAL_COVERAGE_RECORD_INVALID');
    assert(canonical(verify(p.task, p.offer, p.result, p.reference)) === canonical(p.verification)
      && p.record.verdict === p.verification.status && canonical(p.record.reasons) === canonical(p.verification.reasons)
      && p.task.cutoff === p.record.observedAt && time(p.record.recordedAt) >= time(p.task.cutoff),
    'REHEARSAL_COVERAGE_PROOF_INVALID');
    if (p.record.supersedes) {
      const parent = e.bundle.proofs.find((x: any) => x.record.id === p.record.supersedes);
      assert(parent && time(parent.record.recordedAt) < time(p.record.recordedAt), 'REHEARSAL_COVERAGE_CHRONOLOGY_INVALID');
    }
  }
  for (const [wave, count] of [['preflight', 2], ['A', 6], ['B', 10]] as const) {
    const saved = e.readers.find((r: any) => r.wave === wave);
    assert(saved?.state === 'DONE' && saved.manifest.runPermitHash === COVERAGE_RUN_HASH
      && hash(saved.manifest) === saved.hash && saved.result.records.length === count,
    'REHEARSAL_COVERAGE_READER_INVALID');
    const replay = assessRecords(saved.manifest, saved.result.records);
    assert(replay.status === 'PROVIDER_READ_VERIFIED' && canonical(replay.policyChecks) === canonical(saved.result.policyChecks)
      && replay.manifestHash === saved.result.manifestHash, 'REHEARSAL_COVERAGE_READER_REPLAY_INVALID');
    assert(saved.result.hits.length === count && saved.result.inventoryCalls === 2 && saved.result.recallCalls === 1,
      'REHEARSAL_COVERAGE_READER_COUNTS_INVALID');
    for (const entry of saved.manifest.entries) {
      const hit = saved.result.hits.find((x: any) => x.blobId === entry.blobId);
      assert(hit && hash(experience(JSON.parse(hit.text))) === entry.hash, 'REHEARSAL_COVERAGE_HIT_INVALID');
    }
    if (wave !== 'preflight') {
      const supervisor = e.readerSupervisor[wave];
      assert(supervisor.completed === 'READER_EXIT_ZERO' && !supervisor.failedExists
        && canonical(supervisor.response) === canonical(saved.result), 'REHEARSAL_COVERAGE_SUPERVISOR_INVALID');
    }
  }
  assert(Object.entries(LIMITS).every(([key, limit]) => e.counters[key] <= limit)
    && e.counters.status === e.outbox.reduce((sum: number, x: any) => sum + x.polls, 0)
    && e.outbox.every((x: any) => x.polls <= 8)
    && e.audit.stage0RowsUnchanged && e.audit.stage0Effects === 41 && e.audit.stage0Outbox === 2,
  'REHEARSAL_COVERAGE_AUDIT_INVALID');
  return e;
}

export class SavedTenMemory implements MemoryPort {
  mode = 'fixture' as const;
  rows: { blobId: string; record: Experience }[];
  constructor(entries: { blobId: string; record: Experience }[]) { this.rows = structuredClone(entries); }
  async inventory() { return { blobIds: this.rows.map(x => x.blobId), revision: hash(this.rows) }; }
  async recall(_query: string, limit: number) {
    return this.rows.slice(0, limit).map(x => ({ blobId: x.blobId, text: canonical(x.record) }));
  }
  async remember(): Promise<never> { throw new Error('REHEARSAL_WRITE_FORBIDDEN'); }
  async status(): Promise<never> { throw new Error('REHEARSAL_STATUS_FORBIDDEN'); }
}

// The original two job receipts live in the separately hash-bound Stage 0/correction evidence.
export function completeOriginalReceipts<T extends { records: any[] }>(replay: T, original: unknown) {
  const old = validateRehearsalEvidence(original), copy = structuredClone(replay);
  for (const row of copy.records) {
    if (row.receiptSource !== 'ORIGINAL_REHEARSAL_RECEIPTS') continue;
    const correction = row.record.supersedes !== null;
    const record = correction ? old.correction.probe.record : old.stage0.record;
    const receipt = correction ? old.correction['writer-result'].receipt : old.stage0.receipt;
    assert(hash(record) === row.hash && (receipt.blobId ?? receipt.blob_id) === row.blobId
      && (receipt.state === 'done' || receipt.state === 'DONE'), 'REHEARSAL_BASE_RECEIPT_MISMATCH');
    row.receipt = structuredClone(receipt);
  }
  assert(copy.records.every(row => row.receipt !== null), 'REHEARSAL_RECEIPT_MISSING');
  return { ...copy, originalEvidenceHash: REHEARSAL_INPUT_HASH };
}

export async function replayCoverage(raw: unknown) {
  const e = validateCoverageRehearsal(raw), savedB = e.readers.find((r: any) => r.wave === 'B');
  const rows = savedB.manifest.entries.map((entry: any) => ({ blobId: entry.blobId,
    record: savedB.result.records.find((r: any) => r.id === entry.id) }));
  const pairs = [];
  for (const slot of ORDER_A) {
    const before = e.bundle.proofs.find((p: any) => p.slot === slot);
    const after = e.bundle.proofs.find((p: any) => p.slot === slot + 1);
    async function execute(proof: any, stale = false, forceProposal = false) {
      let serviceCalls = 0, referenceCalls = 0;
      // A record is available only at recordedAt, which can follow observedAt by a millisecond.
      const replayTask = { ...proof.task, cutoff: proof.record.recordedAt };
      const output = await cycle(replayTask, [proof.offer], {
        memory: new SavedTenMemory(rows), serviceScope: 'controlled-demo-projection',
        model: { mode: 'fixture', select: async context => forceProposal
          ? { serviceId: proof.offer.id, reason: 'Explicit local guard control.', memoryIds: [] }
          : deterministicSelect(context) },
        service: async () => { serviceCalls++; return structuredClone(stale ? before.result : proof.result); },
        reference: async () => { referenceCalls++; return structuredClone(stale ? before.reference : proof.reference); },
      }, true, { projectionPolicy: PROJECTION_POLICY });
      return { output, serviceCalls, referenceCalls, memoryMode: 'SAVED_TEN_RECORDS_LOCAL_ADAPTER',
        selectorMode: 'LOCAL_DETERMINISTIC_CONTROL', sourceMode: proof.record.evidence.source === 'fixture'
          ? 'SAVED_EXPLICIT_SYNTHETIC_PROJECTION' : 'SAVED_TATUM_CONTROLLED_PROJECTION' };
    }
    const prior = await execute(before, false, true), corrected = await execute(after), stale = await execute(after, true);
    assert(slot < 7 ? prior.output.status === 'BLOCKED' && prior.serviceCalls === 0 && prior.referenceCalls === 0
      : prior.output.status === 'VERIFIED' && prior.output.verification.status === before.verification.status,
    'REHEARSAL_COVERAGE_BEFORE_FAILED');
    assert(corrected.output.status === 'VERIFIED' && corrected.output.verification.status === 'pass'
      && canonical(corrected.output.memoryIds) === canonical([after.record.id])
      && stale.output.status === 'VERIFIED' && stale.output.verification.status === before.verification.status,
    'REHEARSAL_COVERAGE_AFTER_FAILED');
    pairs.push({ slot, scope: `${before.record.serviceId}/${before.record.family}/${before.record.serviceVersion}`,
      source: before.record.evidence.source, parent: before.record, correction: after.record,
      historicalBeforeVerdict: before.verification.status, historicalAfterVerdict: after.verification.status,
      before: prior, after: corrected, staleImplementation: stale });
  }
  const allReceipts = savedB.manifest.entries.map((entry: any) => ({ ...entry,
    record: savedB.result.records.find((r: any) => r.id === entry.id),
    receipt: e.outbox.find((r: any) => r.blob_id === entry.blobId) ?? null,
    receiptSource: BASE_EXPECTED.some(x => x.id === entry.id) ? 'ORIGINAL_REHEARSAL_RECEIPTS' : 'COVERAGE_LIVE_RECEIPT' }));
  return { status: 'OFFLINE_TEN_RECORD_REPLAY_VERIFIED', coverageEvidenceHash: COVERAGE_REHEARSAL_HASH,
    runPermitHash: COVERAGE_RUN_HASH, frozenBundleHash: e.result.frozenBundleHash,
    mainnetMemoriesAlreadyConfirmed: 10, newMainnetWrites: 0, providerCalls: { tatum: 0, walrus: 0, model: 0 },
    additionalSpendLimitUSD: 0, pairs, records: allReceipts,
    historicalProviderUsage: e.counters,
    recordedReaders: ['preflight', 'A', 'B'].map(wave => e.readers.find((r: any) => r.wave === wave)).map((r: any) => ({ wave: r.wave, records: r.result.records.length,
      manifestHash: r.hash, status: r.result.status, policyChecks: r.result.policyChecks,
      presentationMode: 'HISTORICAL_LIVE_RESULT_NOT_NEW_RECALL' })),
    historicalSupersedesChains: 5, newCoverageChains: 4,
    executionMode: 'LOCAL_COMPUTATION_SAVED_PUBLIC_EVIDENCE_NO_REMOTE_RECALL' };
}
