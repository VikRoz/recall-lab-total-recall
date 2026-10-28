// Real adapters; deliberately in-memory SDK/transport shapes. No SDK or HTTP is constructed.
import { assert, canonical, time } from './domain.ts';
import { TatumData } from './providers/tatum.ts';
import { NAMESPACE, WalrusMemory } from './providers/walrus.ts';
import { hash } from './coverage-spec.ts';
import type { Snapshot } from './domain.ts';
export class AdapterStubBackend {
  rows: { blobId: string; text: string }[];
  jobs = new Map<string, { text: string; key: string; slot: number }>();
  counts = { list: 0, recall: 0, remember: 0, status: 0 };
  pageSize: number;
  constructor(rows: { blobId: string; text: string }[], pageSize = 4) { this.rows = structuredClone(rows); this.pageSize = pageSize; }
  client() {
    return {
      listMemories: async (o: any) => {
        this.counts.list++; assert(o.namespace === NAMESPACE && o.limit === 100, 'STUB_NAMESPACE_CHANGED');
        const start = o.cursor ? Number(o.cursor) : 0, end = start + this.pageSize;
        return { memories: this.rows.slice(start, end).map(r => ({ namespace_id: NAMESPACE, blob_id: r.blobId, expires_at: null })),
          snapshot_version: hash(this.rows), must_resync: false, has_more: end < this.rows.length, next_cursor: String(end) };
      },
      recall: async (o: any) => { this.counts.recall++; assert(o.namespace === NAMESPACE && o.limit === 20, 'STUB_RECALL_CHANGED');
        return { results: this.rows.map(r => ({ blob_id: r.blobId, text: r.text })) }; },
      remember: async (text: string, namespace: string, options: any) => {
        this.counts.remember++; assert(namespace === NAMESPACE && typeof options.idempotencyKey === 'string', 'STUB_KEY_MISSING');
        const key = options.idempotencyKey, slot = Number(key.split(':').at(-1)), job = 'stub-adapter-job-' + slot;
        assert(!this.jobs.has(job), 'STUB_DUPLICATE_SUBMISSION'); this.jobs.set(job, { text, key, slot }); return { job_id: job };
      },
      getRememberStatus: async (jobId: string) => {
        this.counts.status++; const job = this.jobs.get(jobId); assert(job, 'STUB_JOB_MISSING');
        const blob = 'SIMULATED_ADAPTER_BLOB_' + job.slot;
        if (!this.rows.some(r => r.blobId === blob)) this.rows.push({ blobId: blob, text: job.text });
        return { status: 'done', blob_id: blob };
      },
    };
  }
  adapter() { return new WalrusMemory(this.client()); }
}
export function stubTatum(source: Snapshot) {
  const requests: any[] = []; let closed = 0;
  const adapter = new TatumData({ ledgerService: { getCheckpoint: async (request: any, options: any) => {
    requests.push(structuredClone(request)); assert(options.timeout === 10000 && options.abort, 'STUB_TATUM_DEADLINE');
    assert(canonical(request.readMask.paths) === canonical(['sequence_number', 'digest', 'summary.timestamp']), 'STUB_TATUM_MASK');
    assert(request.checkpointId.oneofKind === undefined || (request.checkpointId.oneofKind === 'sequenceNumber'
      && request.checkpointId.sequenceNumber === source.version), 'STUB_TATUM_PIN');
    const ms = time(source.asOf);
    return { response: { checkpoint: { sequenceNumber: BigInt(source.version), digest: source.fields.digest,
      summary: { timestamp: { seconds: BigInt(Math.floor(ms / 1000)), nanos: ms % 1000 * 1000000 } } } } };
  } } }, 'mainnet', () => { closed++; });
  return { adapter, requests, closed: () => closed };
}
