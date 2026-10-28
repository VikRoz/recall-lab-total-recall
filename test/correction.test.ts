import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/domain.ts';
import type { Snapshot } from '../src/domain.ts';
import type { MemoryPort } from '../src/memory.ts';
import { OLD_RECORD, OLD_BLOB, CORRECTION_PLAN, PLAN_HASH, WRITE_KEY, prepareCorrection, correctionHash, verifyIndependentCorrection } from '../src/correction.ts';
import { writeCorrection } from '../scripts/write-correction.ts';
import { Journal } from '../src/local-journal.ts';

const now = '2026-10-27T08:00:01.000Z';
function source(): Snapshot { return { network: 'mainnet', target: 'checkpoint:9007199254740993', version: '9007199254740993',
  asOf: '2026-10-27T08:00:00.000Z', fields: { sequenceNumber: '9007199254740993', digest: 'public-test-digest' }, source: 'tatum' }; }
function prepared() { return prepareCorrection(source(), source(), now, now); }
function manifest(record = prepared().record) { return { protocol: CORRECTION_PLAN.protocol, planHash: PLAN_HASH, oldBlobId: OLD_BLOB,
  correctionBlobId: 'correction-blob', correctionId: record.id, recordHash: correctionHash(record), task: prepared().task, correctionRecordedAt: record.recordedAt }; }
function memory(rows: { blobId: string; text: string }[]): MemoryPort {
  return { mode: 'fixture', inventory: async () => ({ blobIds: rows.map(x => x.blobId), revision: 'fixed' }),
    recall: async () => structuredClone(rows), remember: async () => { throw Error('unexpected write'); }, status: async () => { throw Error('unexpected status'); } };
}
function rows() { return [{ blobId: OLD_BLOB, text: canonical(OLD_RECORD) }, { blobId: 'correction-blob', text: canonical(prepared().record) }]; }
test('operator repair requires pinned evidence and preserves exact IDs; no agent execution or model', () => {
  const p = prepared();
  assert.equal(p.record.supersedes, OLD_RECORD.id); assert.equal(p.record.verdict, 'pass');
  assert.deepEqual(p.negativeControl, { status: 'fail', reasons: ['missing:digest'] });
  assert.equal(p.record.evidence.version, '9007199254740993');
  assert.equal(p.modelCalls, 0); assert.equal(p.agentServiceCalls, 0); assert.equal(p.operatorProbe, true);
});
test('wrong reference, missing evidence, stale data, wrong network and time cannot produce correction', () => {
  const changed = source(); changed.fields.digest = 'different';
  assert.throws(() => prepareCorrection(source(), changed, now, now), /REFERENCE_CHANGED/);
  for (const change of [(s: Snapshot) => { delete s.fields.digest; }, (s: Snapshot) => { s.network = 'testnet'; },
    (s: Snapshot) => { s.fields.sequenceNumber = '42'; }, (s: Snapshot) => { s.target = 'other'; }]) {
    const s = source(); change(s); assert.throws(() => prepareCorrection(s, s, now, now), /SOURCE_INVALID/);
  }
  assert.throws(() => prepareCorrection(source(), source(), '2026-10-27T09:00:00.000Z', '2026-10-27T09:00:00.000Z'), /NEGATIVE_CONTROL_FAILED|PROBE_FAILED/);
  assert.throws(() => prepareCorrection(source(), source(), now, '2026-10-27T08:00:00.000Z'), /TIME_INVALID/);
});
test('fresh memory port proves revision continuity before and after cutoff without writer journal', async () => {
  const result = await verifyIndependentCorrection(memory(rows()), manifest());
  assert.equal(result.status, 'CORRECTION_PORTABILITY_VERIFIED');
  assert.deepEqual(result.beforeGuard, [OLD_RECORD.id]); assert.deepEqual(result.afterGuard, []);
  assert.equal(result.deterministicDecision.serviceId, 'atlas');
  assert.deepEqual(result.activeMemoryIds, [prepared().record.id]);
});
test('expected receipt content is bound to the particular blob, not just any returned ID', async () => {
  const swapped = rows(); [swapped[0].text, swapped[1].text] = [swapped[1].text, swapped[0].text];
  await assert.rejects(verifyIndependentCorrection(memory(swapped), manifest()), /BLOB_CONTENT_MISMATCH/);
  const tampered = rows(); const record = prepared().record; record.reasons = ['hidden']; tampered[1].text = canonical(record);
  await assert.rejects(verifyIndependentCorrection(memory(tampered), manifest()), /BLOB_CONTENT_MISMATCH/);
});
test('missing expected receipt, incomplete recall, namespace mutation and missing predecessor fail closed', async () => {
  await assert.rejects(verifyIndependentCorrection(memory(rows().slice(1)), manifest()), /EXPECTED_RECORD_MISSING/);
  const incomplete = memory(rows()); incomplete.recall = async () => rows().slice(0, 1);
  await assert.rejects(verifyIndependentCorrection(incomplete, manifest()), /CONTEXT_INCOMPLETE/);
  const changing = memory(rows()); let calls = 0; changing.inventory = async () => ({ blobIds: rows().map(x => x.blobId), revision: String(++calls) });
  await assert.rejects(verifyIndependentCorrection(changing, manifest()), /CHANGED_DURING_READ/);
  const badRecord = prepared().record; badRecord.supersedes = 'experience:absent';
  const badRows = rows(); badRows[1].text = canonical(badRecord);
  await assert.rejects(verifyIndependentCorrection(memory(badRows), manifest(badRecord)), /REVISION_INVALID/);
});
test('manifest changes and unknown successor hashes stop before remote calls', async () => {
  const m = manifest(); m.planHash = '0'.repeat(64);
  await assert.rejects(verifyIndependentCorrection(memory([]), m), /MANIFEST_INVALID/);
  const bad = manifest(); bad.task = { ...bad.task, requiredFields: ['sequenceNumber'] };
  await assert.rejects(verifyIndependentCorrection(memory([]), bad), /MANIFEST_TASK_INVALID/);
});
test('writer defaults to offline plan and rejects invalid execution flags before credentials or network', async () => {
  const r = await writeCorrection({}, []); assert.equal(r.status, 'PREPARED_NOT_EXECUTED'); assert.equal(r.providerCalls, 0);
  await assert.rejects(writeCorrection({}, ['--execute', '--plan-hash=' + PLAN_HASH]), /NOT_AUTHORIZED/);
});
test('one-shot writer: real orchestration under offline ports; lost acceptance is not repeated', async () => {
  const cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'recall-correction-'));
  const env = { RECALL_CORRECTION_V1_CONFIRMED: PLAN_HASH, RECALL_FREE_TIER_CONFIRMED: 'true', RECALL_WALRUS_SPONSOR_CONFIRMED: 'true',
    TATUM_API_KEY: 'offline-sentinel', MEMWAL_KEY: 'offline-sentinel', MEMWAL_ACCOUNT_ID: 'offline-sentinel' };
  try {
    for (const fail of [false, true]) {
      const { mkdirSync } = await import('node:fs'); const dir = join(root, fail ? 'lost' : 'ok'); mkdirSync(dir); process.chdir(dir);
      let writes = 0, reads = 0, closed = 0;
      const m = memory(rows().slice(0, 1)); m.remember = async () => { writes++; if (fail) throw Error('offline loss'); return { jobId: 'job' }; };
      m.status = async jobId => ({ state: 'done', jobId, blobId: 'correction-blob' });
      const fresh = source(); fresh.asOf = new Date().toISOString();
      const connections = { memory: async () => m, tatum: async () => ({ checkpoint: async () => { reads++; return structuredClone(fresh); }, close: () => { closed++; } }) };
      const args = ['--execute', '--plan-hash=' + PLAN_HASH];
      if (fail) await assert.rejects(writeCorrection(env, args, connections), /WRITE_OUTCOME_UNKNOWN/);
      else {
        const r = await writeCorrection(env, args, connections); assert.equal(r.status, 'CORRECTION_WRITE_CONFIRMED_READER_NOT_RUN');
        assert.equal(existsSync('.local/correction-v1/reader-manifest.json'), true);
        assert.equal(JSON.parse(readFileSync('.local/correction-v1/probe.json', 'utf8')).verification.status, 'pass');
      }
      await assert.rejects(writeCorrection(env, args, connections));
      assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(closed, 1);
      const j = new Journal('.local/stage0.sqlite');
      try { assert.equal(j.outbox(WRITE_KEY).state, fail ? 'UNKNOWN' : 'DONE'); } finally { j.close(); }
    }
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
});
test('status access/timeout uncertainty stops after one status read; accepted job is preserved', async () => {
  const cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'recall-correction-status-'));
  process.chdir(root);
  try {
    const env = { RECALL_CORRECTION_V1_CONFIRMED: PLAN_HASH, RECALL_FREE_TIER_CONFIRMED: 'true', RECALL_WALRUS_SPONSOR_CONFIRMED: 'true',
      TATUM_API_KEY: 'offline-sentinel', MEMWAL_KEY: 'offline-sentinel', MEMWAL_ACCOUNT_ID: 'offline-sentinel' };
    const m = memory(rows().slice(0, 1)); let statuses = 0, submits = 0;
    m.remember = async () => { submits++; return { jobId: 'accepted-job' }; };
    m.status = async () => { statuses++; throw Error('offline access or timeout'); };
    const fresh = source(); fresh.asOf = new Date().toISOString();
    const ports = { memory: async () => m, tatum: async () => ({ checkpoint: async () => structuredClone(fresh), close() {} }) };
    await assert.rejects(writeCorrection(env, ['--execute', '--plan-hash=' + PLAN_HASH], ports), /RECEIPT_NOT_DONE/);
    assert.equal(submits, 1); assert.equal(statuses, 1);
    const j = new Journal('.local/stage0.sqlite');
    try { assert.equal(j.outbox(WRITE_KEY).state, 'ACCEPTED'); assert.equal(j.outbox(WRITE_KEY).job_id, 'accepted-job'); } finally { j.close(); }
    assert.equal(existsSync('.local/correction-v1/reader-manifest.json'), false);
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
});
