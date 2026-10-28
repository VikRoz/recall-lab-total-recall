import { assert, Fault } from '../domain.ts';
import type { MemoryPort, Receipt } from '../memory.ts';

export const NAMESPACE = 'total-recall-stage0';
export const RELAYER = 'https://relayer.memory.walrus.xyz';
// SDK surface from the official API reference; actual version/peer lock remains a Stage-0 gate.
export class WalrusMemory implements MemoryPort {
  mode = 'live' as const;
  client: any;
  constructor(client: any) { this.client = client; }
  async inventory() {
    const blobIds: string[] = []; let cursor: string | undefined; let revision: string | undefined;
    const cursors = new Set<string>();
    for (let pageNo = 0; pageNo < 8; pageNo++) {
      const page = await this.client.listMemories({ namespace: NAMESPACE, limit: 100, ...(cursor ? { cursor } : {}) });
      assert(page.must_resync === false && Array.isArray(page.memories) && page.snapshot_version != null, 'MEMORY_INVENTORY_INVALID');
      const current = String(page.snapshot_version);
      assert(revision === undefined || revision === current, 'MEMORY_CHANGED_DURING_READ'); revision = current;
      for (const row of page.memories) {
        if (row.namespace_id !== NAMESPACE) continue;
        assert(typeof row.blob_id === 'string' && row.blob_id.length > 0, 'MEMORY_INVENTORY_INVALID');
        assert(row.expires_at === null || Date.parse(row.expires_at) > Date.now(), 'MEMORY_EXPIRED');
        blobIds.push(row.blob_id);
      }
      if (page.has_more === false) return { blobIds, revision };
      assert(page.has_more === true && typeof page.next_cursor === 'string' && !cursors.has(page.next_cursor), 'MEMORY_CURSOR_INVALID');
      cursor = page.next_cursor; cursors.add(cursor);
    }
    throw new Fault('MEMORY_PAGINATION_LIMIT');
  }
  async recall(query: string, limit: number) {
    const r = await this.client.recall({ query, limit, namespace: NAMESPACE });
    assert(Array.isArray(r.results), 'MEMORY_RESPONSE_INVALID');
    return r.results.map((x: any) => {
      assert(typeof x.blob_id === 'string' && typeof x.text === 'string', 'MEMORY_RESPONSE_INVALID');
      return { blobId: x.blob_id, text: x.text };
    });
  }
  async remember(text: string, operationKey: string) {
    const r = await this.client.remember(text, NAMESPACE, { idempotencyKey: operationKey });
    return { jobId: r.job_id };
  }
  async status(jobId: string): Promise<Receipt> {
    const r = await this.client.getRememberStatus(jobId);
    if (r.status === 'done') return { state: 'done', jobId, blobId: r.blob_id };
    if (r.status === 'failed') return { state: 'failed', jobId };
    return { state: ['pending', 'running', 'uploaded'].includes(r.status) ? 'pending' : 'unknown', jobId };
  }
}
export async function connectWalrus(env: Record<string, string | undefined>) {
  assert(env.MEMWAL_KEY && env.MEMWAL_ACCOUNT_ID, 'WALRUS_CREDENTIALS_MISSING');
  assert(/^0x[a-fA-F0-9]{64}$/.test(env.MEMWAL_ACCOUNT_ID), 'WALRUS_ACCOUNT_INVALID');
  const packageName = '@mysten-incubation/memwal';
  let sdk: any;
  try { sdk = await import(packageName); } catch { throw new Fault('MEMWAL_SDK_NOT_INSTALLED'); }
  const client = sdk.MemWal.create({ key: env.MEMWAL_KEY, accountId: env.MEMWAL_ACCOUNT_ID, serverUrl: RELAYER, namespace: NAMESPACE,
    requestTimeoutMs: 15000, recallTimeoutMs: 15000, preflightTimeoutMs: 5000 });
  // health() alone proves neither authorization nor compatibility of protected calls.
  await client.compatibility();
  return new WalrusMemory(client);
}
