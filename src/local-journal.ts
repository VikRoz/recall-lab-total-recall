// Local Stage-0 durability. This is not the production D1 adapter.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { assert, canonical, Fault } from './domain.ts';
import type { MemoryPort, Receipt } from './memory.ts';

export function digest(v: unknown) { return createHash('sha256').update(canonical(v)).digest('hex'); }
export class Journal {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS effects (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, day TEXT NOT NULL, hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','DONE','UNKNOWN')), response TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('PLANNED','SUBMITTING','ACCEPTED','DONE','FAILED','UNKNOWN')),
        job_id TEXT, blob_id TEXT
      );`);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  effect(id: string) { return this.db.prepare('SELECT * FROM effects WHERE id=?').get(id) as any; }
  async once<T>(id: string, kind: 'model' | 'tatum', request: unknown, invoke: () => Promise<T>): Promise<T> {
    const hash = digest(request);
    const cached = this.transaction(() => {
      const old = this.effect(id);
      if (old) {
        assert(old.hash === hash && old.kind === kind, 'IDEMPOTENCY_CONFLICT');
        assert(old.state === 'DONE', 'EFFECT_OUTCOME_UNKNOWN');
        return { hit: true, value: JSON.parse(old.response) as T };
      }
      const day = new Date().toISOString().slice(0, 10);
      const used = this.db.prepare('SELECT COUNT(*) AS n FROM effects WHERE day=? AND kind=?').get(day, kind) as any;
      assert(used.n < 64, 'QUOTA_EXHAUSTED');
      this.db.prepare('INSERT INTO effects(id,kind,day,hash,state) VALUES(?,?,?,?,?)').run(id, kind, day, hash, 'IN_FLIGHT');
      return { hit: false };
    });
    if (cached.hit) return cached.value!;
    try {
      const value = await invoke();
      this.db.prepare("UPDATE effects SET state='DONE',response=? WHERE id=? AND state='IN_FLIGHT'").run(canonical(value), id);
      return value;
    } catch {
      this.db.prepare("UPDATE effects SET state='UNKNOWN' WHERE id=? AND state='IN_FLIGHT'").run(id);
      // Provider error strings can contain credentials or raw request bodies.
      throw new Fault('EFFECT_OUTCOME_UNKNOWN');
    }
  }
  plan(id: string, value: unknown) {
    const payload = canonical(value), hash = digest(value);
    return this.transaction(() => {
      const old = this.outbox(id);
      if (old) { assert(old.hash === hash && old.payload === payload, 'IDEMPOTENCY_CONFLICT'); return old; }
      const n = this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as any;
      assert(n.n < 20, 'MEMORY_CORPUS_LIMIT');
      this.db.prepare("INSERT INTO outbox(id,payload,hash,state) VALUES(?,?,?,'PLANNED')").run(id, payload, hash);
      return this.outbox(id);
    });
  }
  outbox(id: string) { return this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as any; }
  async advance(id: string, memory: MemoryPort): Promise<Receipt> {
    let row = this.outbox(id); assert(row, 'OUTBOX_NOT_FOUND');
    if (row.state === 'DONE') return { state: 'done', jobId: row.job_id, blobId: row.blob_id };
    assert(!['UNKNOWN', 'SUBMITTING'].includes(row.state), 'WRITE_OUTCOME_UNKNOWN');
    if (row.state === 'FAILED') return { state: 'failed', jobId: row.job_id };
    if (row.state === 'PLANNED') {
      const claim = this.db.prepare("UPDATE outbox SET state='SUBMITTING' WHERE id=? AND state='PLANNED'").run(id);
      assert(claim.changes === 1, 'STEP_ALREADY_CLAIMED');
      try {
        const accepted = await memory.remember(row.payload, id);
        assert(typeof accepted.jobId === 'string' && accepted.jobId.length > 0, 'WRITE_ACK_INVALID');
        this.db.prepare("UPDATE outbox SET state='ACCEPTED',job_id=? WHERE id=? AND state='SUBMITTING'").run(accepted.jobId, id);
      } catch {
        this.db.prepare("UPDATE outbox SET state='UNKNOWN' WHERE id=? AND state='SUBMITTING'").run(id);
        throw new Fault('WRITE_OUTCOME_UNKNOWN');
      }
      row = this.outbox(id);
    }
    let receipt: Receipt;
    try { receipt = await memory.status(row.job_id); }
    catch { return { state: 'pending', jobId: row.job_id }; }
    assert(receipt.jobId === row.job_id, 'WRITE_RECEIPT_MISMATCH');
    if (receipt.state === 'done') {
      assert(typeof receipt.blobId === 'string' && receipt.blobId.length > 0, 'WRITE_RECEIPT_INVALID');
      this.db.prepare("UPDATE outbox SET state='DONE',blob_id=? WHERE id=? AND state='ACCEPTED'").run(receipt.blobId, id);
    } else if (receipt.state === 'failed') this.db.prepare("UPDATE outbox SET state='FAILED' WHERE id=? AND state='ACCEPTED'").run(id);
    // UNKNOWN status does not authorize a new submission.
    return receipt;
  }
}
