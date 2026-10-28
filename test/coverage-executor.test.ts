import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { canonical, Fault } from '../src/domain.ts';
import { CoverageLedger } from '../src/coverage-ledger.ts';
import { executeCoverage } from '../src/coverage-runner.ts';
import { offlineCoveragePorts, OfflineMemory } from '../src/coverage-offline.ts';
import { readCoverage, LIMITS, hash, COVERAGE_PLAN_HASH } from '../src/coverage-spec.ts';
const planPath = fileURLToPath(new URL('../docs/mainnet-eight-plan-v1.json', import.meta.url));
const inputPath = fileURLToPath(new URL('../evidence/rehearsal-v1/input.json', import.meta.url));
const plan = () => JSON.parse(readFileSync(planPath, 'utf8')), input = () => JSON.parse(readFileSync(inputPath, 'utf8'));
async function fixture(fn: (c: any) => Promise<void>, options: { pendingPerJob?: number; childProcesses?: boolean } = { childProcesses: false }) {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-test-')), path = join(dir, 'coverage-offline.sqlite');
  const ledger = new CoverageLedger(path), d = offlineCoveragePorts(input(), dir, options);
  try { await fn({ dir, path, ledger, d, run: () => executeCoverage(plan(), ledger, d.ports) }); }
  finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
}
test('two waves, immutable proofs and real independent child readers complete within reserved caps', async () => {
  await fixture(async ({ ledger, d, run }) => {
    const r = await run();
    assert.equal(r.status, 'OFFLINE_COVERAGE_COMPLETED'); assert.equal(r.mainnetWrites, 0);
    assert.deepEqual(r.reservations, { tatum: 2, remember: 8, status: 8, inventory: 6, recall: 3 });
    assert.equal(r.waveA.records, 6); assert.equal(r.waveB.records, 10);
    assert.equal(d.processChecks.length, 2); assert.ok(d.processChecks.every((c: any) => c.pid !== process.pid));
    assert.deepEqual(ledger.bundle().proofs.map((p: any) => p.slot), [3, 5, 7, 9, 4, 6, 8, 10]);
    assert.equal(ledger.bundle().proofs.find((p: any) => p.slot === 7).ageMs, 121000);
    assert.equal(ledger.bundle().proofs.find((p: any) => p.slot === 9).record.verdict, 'unknown');
    assert.equal(ledger.bundle().proofs.find((p: any) => p.slot === 9).record.evidence.source, 'fixture');
    assert.ok(ledger.summary().outbox.every((o: any) => o.state === 'DONE'));
  }, { childProcesses: true });
});
test('exact maximum: eight polls per job uses 64 durable reservations and never adds a ninth', async () => {
  await fixture(async ({ ledger, d, run }) => {
    await run(); assert.equal(d.memory.counts.status, 64);
    assert.ok(ledger.summary().outbox.every((o: any) => o.polls === 8));
    assert.throws(() => ledger.reservePoll(3, Date.now()), /POLL_LIMIT/);
  }, { pendingPerJob: 7, childProcesses: false });
});
test('pending exhaustion stops after eight reads of one job and never starts another write', async () => {
  await fixture(async ({ ledger, d, run }) => {
    await assert.rejects(run(), /PENDING_LIMIT/);
    assert.equal(d.memory.counts.status, 8); assert.equal(d.memory.counts.remember, 1);
    assert.equal(ledger.outbox(3).state, 'ACCEPTED'); assert.equal(ledger.run().state, 'STOPPED');
    await assert.rejects(run(), /COVERAGE_STOPPED/); assert.equal(d.memory.counts.remember, 1);
  }, { pendingPerJob: 8, childProcesses: false });
});
test('lost write ACK keeps UNKNOWN and reservation; restart never submits again', async () => {
  await fixture(async ({ ledger, d, run, path }) => {
    const remember = d.memory.remember.bind(d.memory);
    d.memory.remember = async (text: string, key: string) => { await remember(text, key); throw Error('secret-provider-error'); };
    await assert.rejects(run(), /WRITE_UNKNOWN/); assert.equal(ledger.outbox(3).state, 'UNKNOWN');
    assert.equal(ledger.count('remember'), 1); assert.equal(d.memory.jobs.size, 1);
    const restarted = new CoverageLedger(path);
    try { await assert.rejects(executeCoverage(plan(), restarted, d.ports), /COVERAGE_STOPPED/); }
    finally { restarted.close(); }
    assert.equal(d.memory.counts.remember, 1); assert.equal(JSON.stringify(ledger.summary()).includes('secret-provider-error'), false);
  });
});
test('status exception/UNKNOWN/failed or wrong job stop before another job, preserving accepted identity', async () => {
  for (const fault of ['throw', 'unknown', 'failed', 'wrong-job', 'no-blob']) await fixture(async ({ ledger, d, run }) => {
    d.memory.status = async (jobId: string) => {
      d.memory.counts.status++;
      if (fault === 'throw') throw Error('timeout or access');
      return fault === 'unknown' ? { state: 'unknown', jobId } : fault === 'failed' ? { state: 'failed', jobId }
        : fault === 'wrong-job' ? { state: 'done', jobId: 'other-job', blobId: 'fixture-blob' } : { state: 'done', jobId };
    };
    await assert.rejects(run()); assert.equal(ledger.run().state, 'STOPPED');
    assert.equal(ledger.count('status'), 1); assert.equal(d.memory.counts.remember, 1);
    assert.equal(ledger.outbox(3).job_id, 'fixture-job-3');
  });
});
test('quota/access failure in latest/pinned consumes a reservation and cannot retry', async () => {
  for (const failAt of [1, 2]) await fixture(async ({ ledger, d, run }) => {
    let calls = 0; const original = d.ports.checkpoint;
    d.ports.checkpoint = async (seq?: string) => { if (++calls === failAt) throw Error('quota'); return original(seq); };
    await assert.rejects(run(), /EFFECT_UNKNOWN/); assert.equal(ledger.count('tatum'), failAt);
    assert.equal(d.memory.counts.remember, 0); await assert.rejects(run(), /STOPPED/); assert.equal(calls, failAt);
  });
});
test('pinned mismatch, stale source and regressed clock block all writes', async () => {
  for (const fault of ['pinned', 'stale', 'clock']) await fixture(async ({ ledger, d, run }) => {
    if (fault === 'pinned') { const original = d.ports.checkpoint; d.ports.checkpoint = async (seq?: string) => { const r = await original(seq); if (seq) r.fields.digest = 'wrong'; return r; }; }
    else {
      const base = Date.parse(input().correction.probe.source.asOf); let n = 0;
      d.ports.clock.now = () => new Date(base + (fault === 'stale' ? 60001 : ++n <= 2 ? 1000 : 999)).toISOString();
    }
    await assert.rejects(run()); assert.equal(d.memory.counts.remember, 0); assert.equal(ledger.run().state, 'STOPPED');
  });
});
test('wave A timeout or incomplete/changed/forked recall prevents every correction', async () => {
  for (const fault of ['timeout', 'incomplete', 'changed', 'fork', 'swap']) await fixture(async ({ ledger, d, run }) => {
    d.ports.independentRead = async (m: any) => {
      assert.equal(m.wave, 'A');
      if (fault === 'timeout') throw Error('reader timeout');
      const rows = structuredClone(d.memory.rows), memory = new OfflineMemory(rows);
      if (fault === 'incomplete') memory.recall = async () => rows.slice(0, -1);
      if (fault === 'changed') rows[2].text = '{}';
      if (fault === 'fork') { const r = JSON.parse(rows[2].text); r.supersedes = input().stage0.record.id; rows[2].text = JSON.stringify(r); }
      if (fault === 'swap') [rows[2].text, rows[3].text] = [rows[3].text, rows[2].text];
      // Rebuild after changing the public fixture rows.
      if (fault !== 'incomplete') return readCoverage(new OfflineMemory(rows), m);
      return readCoverage(memory, m);
    };
    await assert.rejects(run()); assert.equal(d.memory.counts.remember, 4);
    assert.ok([4, 6, 8, 10].every(s => ledger.outbox(s).state === 'PLANNED'));
    assert.equal(ledger.summary().readers.find((r: any) => r.wave === 'A').state, 'UNKNOWN');
  });
});
test('changed namespace inventory and missing expected baseline stop before Tatum or writes', async () => {
  for (const fault of ['changed', 'missing']) await fixture(async ({ ledger, d, run }) => {
    if (fault === 'missing') d.memory.rows.pop();
    else { let i = 0; const inventory = d.memory.inventory.bind(d.memory); d.memory.inventory = async () => ({ ...await inventory(), revision: String(++i) }); }
    await assert.rejects(run()); assert.equal(d.stats().checkpointCalls, 0); assert.equal(d.memory.counts.remember, 0);
    assert.deepEqual([ledger.count('inventory'), ledger.count('recall')], [2, 1]);
  });
});
test('malformed reader attestation or final recall failure never reports completion', async () => {
  for (const fault of ['fake', 'final']) await fixture(async ({ ledger, d, run }) => {
    const original = d.ports.independentRead;
    d.ports.independentRead = async (m: any) => {
      const r = await original(m);
      if (fault === 'fake') r.manifestHash = '0'.repeat(64);
      else if (m.wave === 'B') r.records.pop();
      return r;
    };
    await assert.rejects(run()); assert.equal(ledger.run().state, 'STOPPED');
    assert.equal(d.memory.counts.remember, fault === 'fake' ? 4 : 8);
  });
});
test('frozen bundle/outbox mutation is detected before next submission', async () => {
  for (const fault of ['bundle', 'payload']) await fixture(async ({ ledger, d, run }) => {
    const status = d.memory.status.bind(d.memory); let changed = false;
    d.memory.status = async (id: string) => {
      const r = await status(id);
      if (!changed) {
        changed = true;
        if (fault === 'bundle') ledger.db.prepare("UPDATE coverage_bundle SET payload='{}'").run();
        else ledger.db.prepare("UPDATE coverage_outbox SET payload='{}' WHERE slot=5").run();
      }
      return r;
    };
    await assert.rejects(run()); assert.equal(d.memory.counts.remember, 1); assert.equal(ledger.run().state, 'STOPPED');
  });
});
test('hard resource caps are transactional and survive reopening the ledger', async () => {
  await fixture(async ({ ledger, path }) => {
    ledger.begin('counter-test');
    for (const kind of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
      ledger.tx(() => ledger.reserve(kind, LIMITS[kind]));
      assert.throws(() => ledger.tx(() => ledger.reserve(kind)), /COVERAGE_LIMIT/);
    }
    const other = new CoverageLedger(path);
    try { for (const kind of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) assert.equal(other.count(kind), LIMITS[kind]); }
    finally { other.close(); }
  });
});
test('poll interval and phase gates cannot be bypassed by direct ledger calls', async () => {
  await fixture(async ({ ledger, d, run }) => {
    const status = d.memory.status.bind(d.memory); let checked = false;
    d.memory.status = async (id: string) => {
      if (!checked) {
        checked = true;
        assert.throws(() => ledger.reservePoll(3, Date.parse(d.ports.clock.now())), /POLL_INTERVAL/);
        assert.throws(() => ledger.claimWrite(4), /WRITE_PHASE/);
      }
      return status(id);
    };
    await run(); assert.equal(ledger.outbox(3).polls, 1);
  });
});
test('completed rerun is inspection-only and reserves/calls nothing', async () => {
  await fixture(async ({ ledger, d, run, path }) => {
    const first = await run(), before = canonical(ledger.summary()), calls = d.memory.counts.remember;
    const other = new CoverageLedger(path);
    try { const r = await executeCoverage(plan(), other, d.ports); assert.equal(r.reusedCompletedRun, true); assert.equal(r.frozenBundleHash, first.frozenBundleHash); }
    finally { other.close(); }
    assert.equal(d.memory.counts.remember, calls); assert.equal(canonical(ledger.summary()), before);
  });
});
test('concurrent start has one winner; second caller does not stop or mutate the first', async () => {
  await fixture(async ({ ledger, d, run, path }) => {
    let release!: () => void; const checkpoint = d.ports.checkpoint;
    d.ports.checkpoint = async (seq?: string) => { if (!seq) await new Promise<void>(resolve => { release = resolve; }); return checkpoint(seq); };
    const first = run(); while (!release) await new Promise(resolve => setImmediate(resolve));
    const other = new CoverageLedger(path);
    try { await assert.rejects(executeCoverage(plan(), other, d.ports), /ALREADY_STARTED/); assert.equal(ledger.run().state, 'RUNNING'); }
    finally { other.close(); }
    release(); assert.equal((await first).status, 'OFFLINE_COVERAGE_COMPLETED'); assert.equal(d.memory.counts.remember, 8);
  });
});
test('hard process exit after remember reservation leaves SUBMITTING; restart cannot retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-crash-')), path = join(dir, 'coverage-offline.sqlite');
  const moduleUrl = (name: string) => new URL('../src/' + name, import.meta.url).href;
  const code = `import {readFileSync} from 'node:fs';
import {CoverageLedger} from ${JSON.stringify(moduleUrl('coverage-ledger.ts'))};
import {executeCoverage} from ${JSON.stringify(moduleUrl('coverage-runner.ts'))};
import {offlineCoveragePorts} from ${JSON.stringify(moduleUrl('coverage-offline.ts'))};
const d=offlineCoveragePorts(JSON.parse(readFileSync(${JSON.stringify(inputPath)},'utf8')),${JSON.stringify(dir)},{childProcesses:false});
d.memory.remember=async()=>{process.exit(77)};
await executeCoverage(JSON.parse(readFileSync(${JSON.stringify(planPath)},'utf8')),new CoverageLedger(${JSON.stringify(path)}),d.ports);`;
  try {
    const p = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15000 });
    assert.equal(p.status, 77, p.stderr);
    const ledger = new CoverageLedger(path), d = offlineCoveragePorts(input(), dir, { childProcesses: false });
    try {
      assert.equal(ledger.outbox(3).state, 'SUBMITTING'); assert.equal(ledger.count('remember'), 1);
      assert.equal(ledger.run().state, 'RUNNING');
      await assert.rejects(executeCoverage(plan(), ledger, d.ports), /ALREADY_STARTED_OR_INTERRUPTED/);
      assert.equal(d.memory.counts.remember, 0); assert.equal(d.stats().checkpointCalls, 0);
    } finally { ledger.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('plan tampering, live mode and foreign database are rejected before any callbacks', async () => {
  await fixture(async ({ ledger, d }) => {
    const p = plan(); p.proposedLiveLimits.walrusRemember = 9;
    await assert.rejects(executeCoverage(p, ledger, d.ports), /PLAN_CHANGED/);
    await assert.rejects(executeCoverage(plan(), ledger, { ...d.ports, mode: 'LIVE' as any }), /LIVE_BINDING/);
    assert.equal(d.memory.counts.inventory, 0); assert.equal(ledger.run(), undefined);
    assert.equal(hash(plan()), COVERAGE_PLAN_HASH);
  });
  const dir = mkdtempSync(join(tmpdir(), 'coverage-foreign-')), path = join(dir, 'coverage-offline.sqlite');
  try {
    const db = new DatabaseSync(path); db.exec('CREATE TABLE valuable(id INTEGER)'); db.close();
    assert.throws(() => new CoverageLedger(path), /FOREIGN_DATABASE/);
    const check = new DatabaseSync(path); assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='coverage_run'").get(), undefined); check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('reader error strings stay private, and completed-state tampering blocks cached success', async () => {
  await fixture(async ({ ledger, d, run }) => {
    d.ports.independentRead = async () => { throw new Fault('PRIVATE_SENTINEL'); };
    await assert.rejects(run(), /COVERAGE_READER_UNCERTAIN/);
    assert.equal(JSON.stringify(ledger.summary()).includes('PRIVATE_SENTINEL'), false);
  });
  await fixture(async ({ ledger, d, run }) => {
    await run(); const before = d.memory.counts.remember;
    ledger.db.prepare('UPDATE coverage_counter SET used=0 WHERE kind=?').run('remember');
    await assert.rejects(run(), /COVERAGE_COMPLETED_STATE_CHANGED/);
    assert.equal(d.memory.counts.remember, before);
  });
});
