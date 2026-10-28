// Default is plan-only. The explicit execution path is a single operator attempt, never an automatic retry.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assert, canonical, Fault } from '../src/domain.ts';
import { CORRECTION_PLAN, PLAN_HASH, OLD_BLOB, WRITE_KEY, checkOld, correctionHash, prepareCorrection, validateManifest } from '../src/correction.ts';
import type { MemoryPort } from '../src/memory.ts';
import { completeMemory } from '../src/memory.ts';

type Connections = {
  memory(env: Record<string, string | undefined>): Promise<MemoryPort>;
  tatum(env: Record<string, string | undefined>): Promise<{ checkpoint(sequence?: string): Promise<import('../src/domain.ts').Snapshot>; close(): void }>;
};
export async function writeCorrection(env = process.env, args = process.argv.slice(2), connections?: Connections) {
  if (args.length === 0) return { status: 'PREPARED_NOT_EXECUTED', plan: CORRECTION_PLAN, planHash: PLAN_HASH, providerCalls: 0 };
  assert(args.length === 2 && args[0] === '--execute' && args[1] === '--plan-hash=' + PLAN_HASH, 'CORRECTION_ARGUMENTS_INVALID');
  assert(env.RECALL_CORRECTION_V1_CONFIRMED === PLAN_HASH && env.RECALL_FREE_TIER_CONFIRMED === 'true'
    && env.RECALL_WALRUS_SPONSOR_CONFIRMED === 'true', 'CORRECTION_NOT_AUTHORIZED');
  assert(env.TATUM_API_KEY && env.MEMWAL_KEY && env.MEMWAL_ACCOUNT_ID, 'CORRECTION_CREDENTIALS_MISSING');
  const directory = '.local/correction-v1';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert(!existsSync(directory + '/probe.json') && !existsSync(directory + '/reader-manifest.json'), 'CORRECTION_ARTIFACT_EXISTS');
  writeFileSync(directory + '/attempt.json', canonical({ planHash: PLAN_HASH, startedAt: new Date().toISOString(), oneShot: true }), { flag: 'wx', mode: 0o600 });
  // An interrupted or failed attempt requires inspection and a separately approved recovery; do not remove this lock.
  const counts: Record<string, number> = { inventory: 0, recall: 0, remember: 0, status: 0, tatum: 0 };
  const limits: Record<string, number> = { inventory: 2, recall: 1, remember: 1, status: 8, tatum: 2 };
  const reserve = (name: string) => {
    assert(counts[name] < limits[name], 'CORRECTION_CALL_LIMIT'); counts[name]++;
    writeFileSync(directory + '/counts.json', canonical({ planHash: PLAN_HASH, counts }), { mode: 0o600 });
  };
  const { Journal } = await import('../src/local-journal.ts');
  const journal = new Journal('.local/stage0.sqlite');
  let tatum: Awaited<ReturnType<Connections['tatum']>> | undefined;
  try {
    assert(!journal.outbox(WRITE_KEY) && !journal.effect('correction:v1:tatum:latest') && !journal.effect('correction:v1:tatum:pinned'), 'CORRECTION_EFFECT_EXISTS');
    const realMemory = connections ? await connections.memory(env) : await (await import('../src/providers/walrus.ts')).connectWalrus(env);
    const memory: MemoryPort = { mode: 'live', inventory: () => { reserve('inventory'); return realMemory.inventory(); },
      recall: (q, n) => { reserve('recall'); return realMemory.recall(q, n); },
      remember: (text, key) => { reserve('remember'); return realMemory.remember(text, key); },
      status: async jobId => {
        reserve('status');
        // Journal.advance treats status exceptions as pending. Convert uncertainty to an explicit stop, rather than loop.
        try { return await realMemory.status(jobId); } catch { return { state: 'unknown', jobId }; }
      } };
    checkOld(await completeMemory(memory, [OLD_BLOB]));
    tatum = connections ? await connections.tatum(env) : await (await import('../src/providers/tatum.ts')).connectTatum(env);
    const source = await journal.once('correction:v1:tatum:latest', 'tatum', { operation: 'latest-checkpoint', network: 'mainnet', planHash: PLAN_HASH }, async () => { reserve('tatum'); return tatum!.checkpoint(); });
    const reference = await journal.once('correction:v1:tatum:pinned', 'tatum', { sequence: source.version, network: 'mainnet', planHash: PLAN_HASH }, async () => { reserve('tatum'); return tatum!.checkpoint(source.version); });
    const now = new Date().toISOString();
    const probe = prepareCorrection(source, reference, now, now);
    writeFileSync(directory + '/probe.json', JSON.stringify({ planHash: PLAN_HASH, ...probe }, null, 2), { flag: 'wx', mode: 0o600 });
    journal.plan(WRITE_KEY, probe.record);
    let receipt;
    for (let i = 0; i < CORRECTION_PLAN.maximums.statusReads; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, CORRECTION_PLAN.statusIntervalMs));
      receipt = await journal.advance(WRITE_KEY, memory);
      if (receipt.state !== 'pending') break;
    }
    assert(receipt?.state === 'done', receipt?.state === 'pending' ? 'CORRECTION_PENDING_LIMIT_REACHED' : 'CORRECTION_RECEIPT_NOT_DONE');
    const manifest = { protocol: CORRECTION_PLAN.protocol, planHash: PLAN_HASH, oldBlobId: OLD_BLOB,
      correctionBlobId: receipt.blobId!, correctionId: probe.record.id, recordHash: correctionHash(probe.record),
      task: probe.task, correctionRecordedAt: probe.record.recordedAt };
    validateManifest(manifest);
    writeFileSync(directory + '/reader-manifest.json', JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    const result = { status: 'CORRECTION_WRITE_CONFIRMED_READER_NOT_RUN', planHash: PLAN_HASH, receipt,
      recordHash: probe.recordHash, counts, modelCalls: 0, additionalSpendLimitUSD: 0 };
    writeFileSync(directory + '/writer-result.json', JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    return result;
  } finally { tatum?.close(); journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await writeCorrection(), null, 2)); }
  catch (error) { console.log(JSON.stringify({ status: 'CORRECTION_BLOCKED', code: error instanceof Fault ? error.code : 'CORRECTION_ATTEMPT_FAILED',
    instruction: 'Preserve attempt, journal and job IDs. No rerun, replacement write, reset or paid fallback.', additionalSpendLimitUSD: 0 })); process.exitCode = 2; }
}
