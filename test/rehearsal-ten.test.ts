import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/domain.ts';
import { completeMemory } from '../src/memory.ts';
import { COVERAGE_REHEARSAL_HASH, replayCoverage, SavedTenMemory, validateCoverageRehearsal } from '../src/rehearsal-coverage.ts';
import { rehearseTen } from '../scripts/rehearse-ten.ts';
import { rehearsalHtml, rehearsalRunbook } from '../src/rehearsal-view.ts';
const original = fileURLToPath(new URL('../evidence/rehearsal-v1/input.json', import.meta.url));
const coverage = fileURLToPath(new URL('../evidence/coverage-mainnet-v1/live-evidence.json', import.meta.url));
const load = () => JSON.parse(readFileSync(coverage, 'utf8'));

test('ten saved records reproduce four corrections, cutoff guards and stale implementations without mutating evidence', async () => {
  const raw = load(), before = canonical(raw), r = await replayCoverage(raw);
  assert.equal(canonical(raw), before); assert.equal(r.coverageEvidenceHash, COVERAGE_REHEARSAL_HASH);
  assert.equal(r.records.length, 10); assert.equal(r.pairs.length, 4);
  assert.deepEqual(r.recordedReaders.map(x => x.records), [2, 6, 10]);
  assert.deepEqual(r.pairs.map(p => p.before.output.status), ['BLOCKED', 'BLOCKED', 'VERIFIED', 'VERIFIED']);
  assert.deepEqual(r.pairs.slice(0, 2).map(p => p.before.serviceCalls), [0, 0]);
  assert.deepEqual(r.pairs.map(p => p.after.output.status === 'VERIFIED' && p.after.output.verification.status), ['pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(r.pairs.map(p => p.staleImplementation.output.status === 'VERIFIED' && p.staleImplementation.output.verification.status), ['fail', 'fail', 'fail', 'unknown']);
  assert.deepEqual(r.pairs.map(p => p.source), ['tatum', 'tatum', 'tatum', 'fixture']);
  assert.equal(r.historicalSupersedesChains, 5); assert.equal(r.newMainnetWrites, 0);
  assert.deepEqual(r.providerCalls, { tatum: 0, walrus: 0, model: 0 });
});
test('missing receipt, forged correction, changed clock/source, incomplete reader or lost exit marker stop before replay', () => {
  for (const mutate of [
    (e: any) => e.outbox.pop(),
    (e: any) => { e.outbox[0].state = 'ACCEPTED'; },
    (e: any) => { e.bundle.proofs[4].record.supersedes = e.bundle.proofs[1].record.id; },
    (e: any) => { e.bundle.proofs[0].record.recordedAt = '2099-01-01T00:00:00Z'; },
    (e: any) => { e.bundle.proofs[3].record.evidence.source = 'tatum'; },
    (e: any) => e.readers.find((r: any) => r.wave === 'B').result.records.pop(),
    (e: any) => { e.readerSupervisor.A.completed = 'READER_FAILED'; },
    (e: any) => { e.effects[0].response.fields.digest = 'forged'; },
  ]) { const e = load(); mutate(e); assert.throws(() => validateCoverageRehearsal(e), /EVIDENCE_CHANGED/); }
});
test('ten-record replay memory rejects writes, copies rows and detects missing expected blobs', async () => {
  const r = await replayCoverage(load()), rows = r.records.map(x => ({ blobId: x.blobId, record: x.record }));
  const a = new SavedTenMemory(rows), b = new SavedTenMemory(rows);
  await assert.rejects(a.remember(), /WRITE_FORBIDDEN/); await assert.rejects(a.status(), /STATUS_FORBIDDEN/);
  a.rows.pop(); assert.equal(b.rows.length, 10);
  await assert.rejects(completeMemory(a, rows.map(x => x.blobId)), /EXPECTED_RECORD_MISSING/);
  assert.equal((await completeMemory(b, rows.map(x => x.blobId))).length, 10);
});
test('unified fresh process strips parent secrets, uses ten saved records and retains original negative model history', async () => {
  const names = ['MEMWAL_KEY', 'TATUM_API_KEY', 'CLOUDFLARE_API_TOKEN', 'MEMWAL_ACCOUNT_ID', 'AWS_SECRET_ACCESS_KEY'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = 'ten-parent-credential-sentinel';
    const r = await rehearseTen(original, coverage);
    assert.equal(r.status, 'UNIFIED_TEN_RECORD_REHEARSAL_VERIFIED'); assert.equal(r.episodes.length, 7);
    assert.equal(r.independentProcess.recordsVerified, 10); assert.equal(r.independentProcess.emptyWorkingDirectory, true);
    assert.notEqual(r.independentProcess.childProcessId, process.pid);
    assert.equal(r.independentProcess.remoteRecallThisRun, false);
    assert.equal(JSON.stringify(r).includes('ten-parent-credential-sentinel'), false);
    assert.equal(r.coverage.records.every(x => x.receipt !== null), true);
    assert.equal(r.recordedModelCaveat.rows.every((x: any) => x.verdict === 'fail'), true);
  } finally { for (const n of names) old[n] === undefined ? delete process.env[n] : process.env[n] = old[n]; }
});
test('missing, symlinked, oversized or tampered coverage input blocks with no fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ten-evidence-reject-'));
  try {
    const link = join(dir, 'link.json'); symlinkSync(coverage, link);
    const big = join(dir, 'big.json'); writeFileSync(big, ' '.repeat(131073));
    const changed = join(dir, 'changed.json'); const e = load(); e.outbox.pop(); writeFileSync(changed, JSON.stringify(e));
    await assert.rejects(rehearseTen(original, join(dir, 'missing.json')));
    await assert.rejects(rehearseTen(original, link), /FILE_INVALID/);
    await assert.rejects(rehearseTen(original, big), /FILE_INVALID/);
    await assert.rejects(rehearseTen(original, changed), /EVIDENCE_CHANGED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('presentation is deterministic, labels all ten receipts and blocks network; markup is escaped', async () => {
  const a = await rehearseTen(original, coverage), b = await rehearseTen(original, coverage);
  const html = rehearsalHtml(a), md = rehearsalRunbook(a);
  assert.equal(html, rehearsalHtml(b)); assert.equal(md, rehearsalRunbook(b));
  assert.equal((html.match(/class="episode" id="episode-/g) ?? []).length, 7);
  assert.equal((html.match(/class="episode"/g) ?? []).length, 7);
  assert.equal(html.includes('class="record-evidence"'), true);
  for (const r of a.coverage.records) assert.equal(html.includes(r.blobId), true);
  assert.equal(html.includes('10 / 10'), true); assert.equal(html.includes('fixture · синтетика'), true);
  assert.equal(html.includes("connect-src 'none'"), true);
  assert.equal(/fetch\(|XMLHttpRequest|<iframe|<form|<img|\bsrc\s*=/i.test(html), false);
  assert.equal(md.includes('это не новый live recall') || md.includes('Это не новый live recall'), true);
  const attack = structuredClone(a); attack.episodes[4].summary[1] = '</p><script>alert(1)</script>';
  attack.coverage.records[0].id = '</td><script>alert(2)</script>';
  const safe = rehearsalHtml(attack);
  assert.equal(safe.includes('</p><script>alert(1)'), false); assert.equal(safe.includes('</td><script>alert(2)'), false);
});
