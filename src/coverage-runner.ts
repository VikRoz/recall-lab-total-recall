import { assert, canonical, experience, Fault, time } from './domain.ts';
import type { Snapshot } from './domain.ts';
import type { MemoryPort } from './memory.ts';
import { CoverageLedger } from './coverage-ledger.ts';
import { assessRecords, BASE_EXPECTED, buildBundle, COVERAGE_PLAN_HASH, hash, ORDER_A, ORDER_B, readCoverage, validateManifest, validatePlan } from './coverage-spec.ts';
import type { Clock, CoverageMode, Manifest } from './coverage-spec.ts';

export type CoveragePorts = {
  mode: CoverageMode; memory: MemoryPort; clock: Clock;
  runPermitHash?: string; authorize?(): void;
  checkpoint(sequence?: string): Promise<Snapshot>;
  independentRead(manifest: Manifest): Promise<Awaited<ReturnType<typeof readCoverage>> & { processId?: number }>;
  close?(): void;
};
function manifestFor(ledger: CoverageLedger, wave: Manifest['wave'], ports: CoveragePorts): Manifest {
  const slots = wave === 'preflight' ? [] : wave === 'A' ? ORDER_A : [...ORDER_A, ...ORDER_B];
  const entries = structuredClone(BASE_EXPECTED);
  for (const slot of slots) {
    const row = ledger.outbox(slot), proof = ledger.bundle().proofs.find(p => p.slot === slot)!;
    assert(row?.state === 'DONE' && row.hash === proof.recordHash, 'COVERAGE_RECEIPT_NOT_DONE');
    entries.push({ id: proof.record.id, blobId: row.blob_id, hash: row.hash });
  }
  const manifest: Manifest = { mode: ports.mode, ...(ports.mode === 'LIVE_MAINNET' ? { runPermitHash: ports.runPermitHash } : {}), planHash: COVERAGE_PLAN_HASH, wave, entries };
  validateManifest(manifest); return manifest;
}
async function read(ledger: CoverageLedger, ports: CoveragePorts, wave: Manifest['wave']) {
  const m = manifestFor(ledger, wave, ports); ledger.reserveRead(m);
  try {
    let r;
    if (wave === 'preflight') r = await readCoverage(ports.memory, structuredClone(m));
    else {
      try { r = await ports.independentRead(structuredClone(m)); }
      catch { throw new Fault('COVERAGE_READER_UNCERTAIN'); }
    }
    assert(r.manifestHash === hash(m) && r.inventoryCalls === 2 && r.recallCalls === 1, 'COVERAGE_READER_BINDING_CHANGED');
    const check = assessRecords(m, r.records);
    assert(r.status === check.status && canonical(r.policyChecks) === canonical(check.policyChecks)
      && r.hits.length === m.entries.length && new Set(r.hits.map(h => h.blobId)).size === m.entries.length, 'COVERAGE_READER_PROOF_CHANGED');
    for (const hit of r.hits) {
      const entry = m.entries.find(e => e.blobId === hit.blobId), record = experience(JSON.parse(hit.text));
      assert(entry && entry.id === record.id && entry.hash === hash(record), 'COVERAGE_READER_BLOB_CHANGED');
    }
    ledger.finishRead(wave, r); return r;
  } catch (error) { ledger.unknownRead(wave); throw error; }
}
async function writeSlot(ledger: CoverageLedger, ports: CoveragePorts, slot: number) {
  const claim = ledger.claimWrite(slot);
  try {
    const accepted = await ports.memory.remember(claim.payload, claim.operationKey);
    ledger.accepted(slot, accepted.jobId);
  } catch { ledger.uncertainWrite(slot); throw new Fault('COVERAGE_WRITE_UNKNOWN'); }
  for (let i = 0; i < 8; i++) {
    if (i) await ports.clock.sleep(5000);
    const jobId = ledger.reservePoll(slot, time(ports.clock.now()));
    let receipt;
    try { receipt = await ports.memory.status(jobId); }
    catch { throw new Fault('COVERAGE_STATUS_READ_UNKNOWN'); }
    ledger.receipt(slot, receipt);
    if (receipt.state === 'done') return;
  }
  throw new Fault('COVERAGE_PENDING_LIMIT');
}
export async function executeCoverage(plan: unknown, ledger: CoverageLedger, ports: CoveragePorts) {
  validatePlan(plan);
  assert(['OFFLINE_FIXTURE', 'ADAPTER_DRY_RUN', 'LIVE_MAINNET'].includes(ports.mode)
    && ports.memory.mode === (ports.mode === 'OFFLINE_FIXTURE' ? 'fixture' : 'live'), 'COVERAGE_LIVE_BINDING_NOT_ENABLED');
  if (ports.mode === 'LIVE_MAINNET') {
    assert(ledger.path.endsWith('/coverage-mainnet.sqlite') && typeof ports.authorize === 'function'
      && /^[a-f0-9]{64}$/.test(ports.runPermitHash ?? ''), 'COVERAGE_LIVE_AUTHORIZATION_REQUIRED');
    ports.authorize();
  } else assert(ports.authorize === undefined && ports.runPermitHash === undefined, 'COVERAGE_UNEXPECTED_PERMIT');
  const cached = ledger.begin(hash({ planHash: COVERAGE_PLAN_HASH, baseline: BASE_EXPECTED, mode: ports.mode,
    ...(ports.mode === 'LIVE_MAINNET' ? { runPermitHash: ports.runPermitHash } : {}) }));
  if (cached) return { ...cached, reusedCompletedRun: true };
  try {
    ledger.phase('CREATED', 'PREFLIGHT'); await read(ledger, ports, 'preflight');
    ledger.phase('PREFLIGHT', 'SOURCE');
    const source = await ledger.effect('coverage:v1:tatum:latest', 'tatum', { network: 'mainnet', operation: 'latest', planHash: COVERAGE_PLAN_HASH }, () => ports.checkpoint());
    const reference = await ledger.effect('coverage:v1:tatum:pinned', 'tatum', { network: 'mainnet', sequence: source.version, planHash: COVERAGE_PLAN_HASH }, () => ports.checkpoint(source.version));
    ledger.freeze(await buildBundle(plan, source, reference, ports.clock));
    ledger.phase('SOURCE', 'FROZEN'); ledger.phase('FROZEN', 'WAVE_A_WRITING');
    for (const slot of ORDER_A) await writeSlot(ledger, ports, slot);
    ledger.phase('WAVE_A_WRITING', 'WAVE_A_READING'); const waveA = await read(ledger, ports, 'A');
    ledger.phase('WAVE_A_READING', 'WAVE_B_WRITING');
    for (const slot of ORDER_B) await writeSlot(ledger, ports, slot);
    ledger.phase('WAVE_B_WRITING', 'FINAL_READING'); const waveB = await read(ledger, ports, 'B');
    const summary = ledger.summary();
    assert(summary.outbox.length === 8 && summary.outbox.every((r: any) => r.state === 'DONE'), 'COVERAGE_INCOMPLETE');
    const live = ports.mode === 'LIVE_MAINNET';
    const result = { status: live ? 'COVERAGE_MAINNET_COMPLETED' : ports.mode === 'ADAPTER_DRY_RUN' ? 'ADAPTER_DRY_RUN_COMPLETED' : 'OFFLINE_COVERAGE_COMPLETED',
      mode: live ? 'REAL_PROVIDER_EXECUTION' : ports.mode === 'ADAPTER_DRY_RUN' ? 'REAL_ADAPTERS_STUB_CLIENTS' : 'SIMULATED_WRITES_NO_MAINNET', planHash: COVERAGE_PLAN_HASH,
      frozenBundleHash: hash(ledger.bundle()), ...(live ? { confirmedRecords: 10, confirmedNewWrites: 8 } : { simulatedRecords: 10, simulatedNewWrites: 8 }),
      reservations: summary.reservations, perJob: summary.outbox, waveA: { records: waveA.records.length, manifestHash: waveA.manifestHash },
      waveB: { records: waveB.records.length, manifestHash: waveB.manifestHash },
      providerApiCalls: live ? null : 0, mainnetWrites: live ? 8 : 0, actualMainnetCountLastConfirmed: live ? 10 : 2, additionalSpendLimitUSD: 0,
      liveBindingReady: ports.mode !== 'OFFLINE_FIXTURE', requiresSeparateLiveApproval: !live };
    ledger.done(result); return result;
  } catch (error) {
    ledger.stop(error instanceof Fault ? error.code : 'COVERAGE_EXECUTION_FAILED');
    throw error instanceof Fault ? error : new Fault('COVERAGE_EXECUTION_FAILED');
  } finally { ports.close?.(); }
}
