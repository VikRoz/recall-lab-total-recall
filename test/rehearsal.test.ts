import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonical } from '../src/domain.ts';
import { completeMemory } from '../src/memory.ts';
import { runRehearsal, runFreshRehearsal, validateRehearsalEvidence, RehearsalMemory, REHEARSAL_INPUT_HASH } from '../src/rehearsal.ts';
import { rehearse } from '../scripts/rehearse.ts';
import { rehearsalHtml, rehearsalRunbook } from '../src/rehearsal-view.ts';
const path = fileURLToPath(new URL('../evidence/rehearsal-v1/input.json', import.meta.url));
const load = () => JSON.parse(readFileSync(path, 'utf8'));
test('real saved evidence reproduces original failure and scoped controls without mutating inputs', async () => {
  const raw = load(), before = canonical(raw), r = await runRehearsal(raw);
  assert.equal(canonical(raw), before); assert.equal(r.evidenceHash, REHEARSAL_INPUT_HASH);
  assert.deepEqual(r.episodes.slice(0, 3).map((e: any) => [e.output.decision.serviceId, e.output.verification.status]),
    [['atlas', 'fail'], ['beacon', 'pass'], ['atlas', 'pass']]);
  const memory: any = r.episodes[1];
  assert.equal(memory.withoutMemory.output.verification.status, 'fail');
  assert.equal(memory.badProposal.output.status, 'BLOCKED'); assert.equal(memory.badProposal.serviceCalls, 0);
  assert.deepEqual(memory.badProposal.output.decision.memoryIds, []);
  assert.deepEqual(r.providerCalls, { tatum: 0, walrus: 0, model: 0 });
  assert.equal(r.recordedIndependentReader.presentationMode, 'HISTORICAL_LIVE_RESULT_NOT_NEW_RECALL');
});
test('tampered source, receipt, model answer, supersedes, evidence ID or removed record stop before replay', () => {
  for (const change of [
    (e: any) => { e.stage0.effects['stage0:tatum:source'].response = '{}'; },
    (e: any) => { e.stage0.receipt.state = 'PENDING'; },
    (e: any) => { e.stage0.effects['stage0:model:select'].response = '{"serviceId":"beacon"}'; },
    (e: any) => { e.correction.probe.record.supersedes = null; },
    (e: any) => { e.correction['reader-manifest'].correctionBlobId = 'fake'; },
    (e: any) => { e.stage0.record = null; },
  ]) { const e = load(); change(e); assert.throws(() => validateRehearsalEvidence(e), /EVIDENCE_CHANGED/); }
});
test('replay memory is read-only, copied per session and complete for both actual expected blobs', async () => {
  const e = validateRehearsalEvidence(load()), a = new RehearsalMemory(e), b = new RehearsalMemory(e);
  await assert.rejects(a.remember(), /WRITE_FORBIDDEN/); await assert.rejects(a.status(), /STATUS_FORBIDDEN/);
  a.rows.pop(); assert.equal(b.rows.length, 2);
  const expected = [e.correction['reader-manifest'].oldBlobId, e.correction['reader-manifest'].correctionBlobId];
  await assert.rejects(completeMemory(a, expected), /EXPECTED_RECORD_MISSING/);
  assert.equal((await completeMemory(b, expected)).length, 2);
});
test('correction admits an explicitly repaired port but does not bless the old broken implementation', async () => {
  const r = await runFreshRehearsal(load());
  assert.equal(r.output.status, 'VERIFIED');
  assert.equal(r.output.status === 'VERIFIED' && r.output.verification.status, 'pass');
  assert.equal(r.output.decision.serviceId, 'atlas');
  assert.equal(r.staleImplementationControl.verdict, 'fail');
  assert.equal(r.sourceMode, 'SAVED_TATUM_SNAPSHOT');
});
test('unified runner verifies an actual separate process and strips credential environment', async () => {
  const names = ['MEMWAL_KEY', 'TATUM_API_KEY', 'CLOUDFLARE_API_TOKEN'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = 'offline-parent-sentinel';
    const r = await rehearse(path);
    assert.equal(r.status, 'UNIFIED_REHEARSAL_VERIFIED'); assert.equal(r.episodes.length, 5);
    assert.notEqual(r.independentProcess.childProcessId, process.pid);
    assert.equal(r.independentProcess.credentialEnvironment, 'NONE');
    assert.equal(r.independentProcess.remoteRecallThisRun, false);
    assert.equal(JSON.stringify(r).includes('offline-parent-sentinel'), false);
  } finally { for (const n of names) old[n] === undefined ? delete process.env[n] : process.env[n] = old[n]; }
});
test('standalone presentation retains provenance, negative model history and blocks all network connections', async () => {
  const r = await rehearse(path), html = rehearsalHtml(r), md = rehearsalRunbook(r);
  assert.equal((html.match(/class="episode"/g) ?? []).length, 5);
  assert.equal(html.includes("connect-src 'none'"), true);
  assert.equal(/fetch\(|XMLHttpRequest|<iframe|<form|<img|\bsrc\s*=/i.test(html), false);
  assert.equal(html.includes('fail и без памяти, и с ней'), true);
  assert.equal(md.includes('не новый live recall'), true);
  assert.equal(html.includes('qpQxhrCw4zsgJm3UmZSUpwzotfOsEF6lcH3A2qyKRIE'), true);
  const injected = structuredClone(r); injected.receipts.original.id = '</pre><script>alert(1)</script>';
  assert.equal(rehearsalHtml(injected).includes('</pre><script>alert(1)'), false);
});
