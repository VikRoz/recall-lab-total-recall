import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { assert, canonical, Fault } from './domain.ts';
import { COVERAGE_PLAN_HASH, LIMITS, hash } from './coverage-spec.ts';
import type { Bundle, Manifest, Resource } from './coverage-spec.ts';

export class CoverageLedger {
  db: DatabaseSync;
  path: string;
  constructor(path: string) {
    assert(path === ':memory:' || path.endsWith('/coverage-offline.sqlite') || path.endsWith('/coverage-mainnet.sqlite'), 'COVERAGE_LEDGER_PATH');
    this.path = path;
    assert(!existsSync(path) || !lstatSync(path).isSymbolicLink(), 'COVERAGE_LEDGER_SYMLINK');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL;');
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
      assert(!tables.length || tables.some(r => r.name === 'coverage_run'), 'COVERAGE_FOREIGN_DATABASE');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS coverage_run(id INTEGER PRIMARY KEY CHECK(id=1), plan_hash TEXT NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL, result TEXT, code TEXT);
        CREATE TABLE IF NOT EXISTS coverage_counter(kind TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used>=0));
        CREATE TABLE IF NOT EXISTS coverage_effect(id TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, response TEXT);
        CREATE TABLE IF NOT EXISTS coverage_bundle(id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS coverage_outbox(slot INTEGER PRIMARY KEY, operation_key TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, job_id TEXT UNIQUE, blob_id TEXT UNIQUE, polls INTEGER NOT NULL DEFAULT 0, last_poll INTEGER);
        CREATE TABLE IF NOT EXISTS coverage_reader(wave TEXT PRIMARY KEY, hash TEXT NOT NULL, manifest TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      `);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  tx<T>(f: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const r = f(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  run() { return this.db.prepare('SELECT * FROM coverage_run WHERE id=1').get() as any; }
  begin(binding: string) {
    return this.tx(() => {
      const old = this.run();
      if (old) {
        assert(old.plan_hash === COVERAGE_PLAN_HASH && old.binding === binding, 'COVERAGE_BINDING_CHANGED');
        assert(old.state === 'DONE', old.state === 'STOPPED' ? 'COVERAGE_STOPPED' : 'COVERAGE_ALREADY_STARTED_OR_INTERRUPTED');
        const cached = JSON.parse(old.result);
        assert(hash(this.bundle()) === cached.frozenBundleHash && canonical(this.summary().outbox) === canonical(cached.perJob)
          && canonical(this.summary().reservations) === canonical(cached.reservations), 'COVERAGE_COMPLETED_STATE_CHANGED');
        return cached;
      }
      this.db.prepare("INSERT INTO coverage_run(id,plan_hash,binding,state,phase) VALUES(1,?,?,'RUNNING','CREATED')").run(COVERAGE_PLAN_HASH, binding);
      return null;
    });
  }
  running() { assert(this.run()?.state === 'RUNNING', 'COVERAGE_NOT_RUNNING'); }
  phase(from: string, next: string) {
    const r = this.db.prepare("UPDATE coverage_run SET phase=? WHERE id=1 AND state='RUNNING' AND phase=?").run(next, from);
    assert(r.changes === 1, 'COVERAGE_PHASE_INVALID');
  }
  stop(code: string) { this.db.prepare("UPDATE coverage_run SET state='STOPPED',code=? WHERE id=1 AND state='RUNNING'").run(code); }
  count(kind: Resource) { return Number((this.db.prepare('SELECT used FROM coverage_counter WHERE kind=?').get(kind) as any)?.used ?? 0); }
  reserve(kind: Resource, n = 1) {
    this.running(); const used = this.count(kind);
    assert(Number.isInteger(n) && n > 0 && used + n <= LIMITS[kind], 'COVERAGE_LIMIT_' + kind.toUpperCase());
    this.db.prepare('INSERT INTO coverage_counter(kind,used) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET used=excluded.used').run(kind, used + n);
  }
  async effect<T>(id: string, kind: 'tatum', request: unknown, invoke: () => Promise<T>): Promise<T> {
    this.tx(() => {
      assert(!this.db.prepare('SELECT id FROM coverage_effect WHERE id=?').get(id), 'COVERAGE_EFFECT_EXISTS');
      this.reserve(kind); this.db.prepare("INSERT INTO coverage_effect(id,kind,hash,state) VALUES(?,?,?,'RESERVED')").run(id, kind, hash(request));
    });
    try {
      const result = await invoke();
      this.db.prepare("UPDATE coverage_effect SET state='DONE',response=? WHERE id=? AND state='RESERVED'").run(canonical(result), id);
      return structuredClone(result);
    } catch {
      this.db.prepare("UPDATE coverage_effect SET state='UNKNOWN' WHERE id=? AND state='RESERVED'").run(id);
      throw new Fault('COVERAGE_EFFECT_UNKNOWN');
    }
  }
  freeze(bundle: Bundle) {
    this.tx(() => {
      this.running(); assert(!this.db.prepare('SELECT id FROM coverage_bundle').get(), 'COVERAGE_ALREADY_FROZEN');
      this.db.prepare('INSERT INTO coverage_bundle(id,hash,payload) VALUES(1,?,?)').run(hash(bundle), canonical(bundle));
      for (const p of bundle.proofs) this.db.prepare("INSERT INTO coverage_outbox(slot,operation_key,hash,payload,state) VALUES(?,?,?,?,'PLANNED')")
        .run(p.slot, p.operationKey, p.recordHash, canonical(p.record));
    });
  }
  bundle(): Bundle {
    const r = this.db.prepare('SELECT * FROM coverage_bundle WHERE id=1').get() as any;
    assert(r && hash(JSON.parse(r.payload)) === r.hash, 'COVERAGE_FROZEN_BUNDLE_CHANGED'); return JSON.parse(r.payload);
  }
  outbox(slot: number) { return this.db.prepare('SELECT * FROM coverage_outbox WHERE slot=?').get(slot) as any; }
  claimWrite(slot: number) {
    return this.tx(() => {
      assert(this.run()?.phase === (slot % 2 ? 'WAVE_A_WRITING' : 'WAVE_B_WRITING'), 'COVERAGE_WRITE_PHASE');
      const b = this.bundle(), row = this.outbox(slot), proof = b.proofs.find(p => p.slot === slot);
      assert(row && proof && row.hash === proof.recordHash && row.payload === canonical(proof.record)
        && row.operation_key === proof.operationKey && row.state === 'PLANNED', 'COVERAGE_OUTBOX_CHANGED');
      if (proof.record.supersedes) {
        const parent = b.proofs.find(p => p.record.id === proof.record.supersedes)!;
        assert(this.outbox(parent.slot)?.state === 'DONE' && (this.db.prepare("SELECT state FROM coverage_reader WHERE wave='A'").get() as any)?.state === 'DONE', 'COVERAGE_PARENT_NOT_READ');
      }
      this.reserve('remember');
      this.db.prepare("UPDATE coverage_outbox SET state='SUBMITTING' WHERE slot=? AND state='PLANNED'").run(slot);
      return { payload: row.payload, operationKey: row.operation_key };
    });
  }
  accepted(slot: number, jobId: string) {
    assert(typeof jobId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(jobId), 'COVERAGE_ACK_INVALID');
    const r = this.db.prepare("UPDATE coverage_outbox SET state='ACCEPTED',job_id=? WHERE slot=? AND state='SUBMITTING'").run(jobId, slot);
    assert(r.changes === 1, 'COVERAGE_ACK_STATE');
  }
  uncertainWrite(slot: number) { this.db.prepare("UPDATE coverage_outbox SET state='UNKNOWN' WHERE slot=? AND state='SUBMITTING'").run(slot); }
  reservePoll(slot: number, now: number) {
    return this.tx(() => {
      const row = this.outbox(slot);
      assert(row?.state === 'ACCEPTED' && row.polls < 8, 'COVERAGE_JOB_POLL_LIMIT');
      assert(Number.isSafeInteger(now) && (row.last_poll === null || now - row.last_poll >= 5000), 'COVERAGE_POLL_INTERVAL');
      this.reserve('status'); this.db.prepare('UPDATE coverage_outbox SET polls=polls+1,last_poll=? WHERE slot=?').run(now, slot);
      return row.job_id as string;
    });
  }
  receipt(slot: number, receipt: any) {
    const row = this.outbox(slot);
    assert(row?.state === 'ACCEPTED' && receipt.jobId === row.job_id, 'COVERAGE_RECEIPT_MISMATCH');
    if (receipt.state === 'done') {
      assert(typeof receipt.blobId === 'string' && receipt.blobId.length > 0, 'COVERAGE_BLOB_MISSING');
      this.db.prepare("UPDATE coverage_outbox SET state='DONE',blob_id=? WHERE slot=?").run(receipt.blobId, slot);
    } else if (receipt.state === 'failed') {
      this.db.prepare("UPDATE coverage_outbox SET state='FAILED' WHERE slot=?").run(slot); throw new Fault('COVERAGE_JOB_FAILED');
    } else assert(receipt.state === 'pending', 'COVERAGE_STATUS_UNKNOWN');
  }
  reserveRead(manifest: Manifest) {
    this.tx(() => {
      const phases = { preflight: 'PREFLIGHT', A: 'WAVE_A_READING', B: 'FINAL_READING' };
      assert(this.run()?.phase === phases[manifest.wave], 'COVERAGE_READ_PHASE');
      this.running(); assert(!this.db.prepare('SELECT wave FROM coverage_reader WHERE wave=?').get(manifest.wave), 'COVERAGE_READ_ALREADY_RESERVED');
      this.reserve('inventory', 2); this.reserve('recall');
      this.db.prepare("INSERT INTO coverage_reader(wave,hash,manifest,state) VALUES(?,?,?,'RESERVED')").run(manifest.wave, hash(manifest), canonical(manifest));
    });
  }
  finishRead(wave: string, result: unknown) {
    const r = this.db.prepare("UPDATE coverage_reader SET state='DONE',result=? WHERE wave=? AND state='RESERVED'").run(canonical(result), wave);
    assert(r.changes === 1, 'COVERAGE_READ_STATE');
  }
  unknownRead(wave: string) { this.db.prepare("UPDATE coverage_reader SET state='UNKNOWN' WHERE wave=? AND state='RESERVED'").run(wave); }
  summary() {
    return { run: this.run(), reservations: Object.fromEntries(Object.keys(LIMITS).map(k => [k, this.count(k as Resource)])),
      outbox: this.db.prepare('SELECT slot,operation_key,hash,state,job_id,blob_id,polls FROM coverage_outbox ORDER BY slot').all(),
      readers: this.db.prepare('SELECT wave,hash,state FROM coverage_reader ORDER BY wave').all(),
      effects: this.db.prepare('SELECT id,kind,hash,state FROM coverage_effect ORDER BY id').all() };
  }
  done(result: unknown) {
    assert(this.run()?.phase === 'FINAL_READING', 'COVERAGE_PHASE_INVALID');
    const r = this.db.prepare("UPDATE coverage_run SET state='DONE',phase='DONE',result=? WHERE id=1 AND state='RUNNING'").run(canonical(result));
    assert(r.changes === 1, 'COVERAGE_NOT_RUNNING');
  }
}
