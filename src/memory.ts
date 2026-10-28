import { assert, experience, scope, time } from './domain.ts';
import type { Experience, Task, Offer } from './domain.ts';

export type Inventory = { blobIds: string[]; revision: string };
export type Hit = { blobId: string; text: string };
export type Receipt = { state: 'pending' | 'done' | 'failed' | 'unknown'; jobId: string; blobId?: string };
export type MemoryPort = {
  mode: 'fixture' | 'live';
  inventory(): Promise<Inventory>;
  recall(query: string, limit: number): Promise<Hit[]>;
  remember(text: string, operationKey: string): Promise<{ jobId: string }>;
  status(jobId: string): Promise<Receipt>;
};
const MAX_CORPUS = 20;
// This bounded demo reads the complete namespace before choosing model context.
// A semantic top-6 result alone cannot establish revision closure.
export async function completeMemory(port: MemoryPort, expectedBlobIds: string[] = []): Promise<Experience[]> {
  const before = await port.inventory();
  assert(expectedBlobIds.every(id => before.blobIds.includes(id)), 'MEMORY_EXPECTED_RECORD_MISSING');
  assert(before.blobIds.length <= MAX_CORPUS, 'MEMORY_CORPUS_LIMIT');
  assert(new Set(before.blobIds).size === before.blobIds.length, 'MEMORY_DUPLICATE_BLOB');
  const hits = before.blobIds.length ? await port.recall('service experience verification', MAX_CORPUS) : [];
  const after = await port.inventory();
  assert(before.revision === after.revision && [...before.blobIds].sort().join('|') === [...after.blobIds].sort().join('|'), 'MEMORY_CHANGED_DURING_READ');
  assert(hits.length === before.blobIds.length && new Set(hits.map(x => x.blobId)).size === hits.length
    && hits.every(x => before.blobIds.includes(x.blobId)), 'MEMORY_CONTEXT_INCOMPLETE');
  const records = hits.map(x => {
    assert(new TextEncoder().encode(x.text).length <= 4096, 'MEMORY_RECORD_TOO_LARGE');
    return experience(JSON.parse(x.text));
  });
  assert(new Set(records.map(x => x.id)).size === records.length, 'MEMORY_DUPLICATE_ID');
  // Corrections must point to an older record in the same scope.
  for (const e of records) if (e.supersedes !== null) {
    const previous = records.find(x => x.id === e.supersedes);
    assert(previous && scope(previous) === scope(e) && time(previous.recordedAt) < time(e.recordedAt), 'MEMORY_REVISION_INVALID');
    assert(records.filter(x => x.supersedes === e.supersedes).length === 1, 'MEMORY_REVISION_FORK');
  }
  return records;
}
export function applicable(records: Experience[], task: Task, offers: Offer[]): Experience[] {
  const visible = records.filter(e => time(e.recordedAt) <= time(task.cutoff) && time(e.observedAt) <= time(task.cutoff));
  const superseded = new Set(visible.map(x => x.supersedes).filter(Boolean));
  const relevant = visible.filter(e => !superseded.has(e.id) && e.network === task.network && e.family === task.family
    && offers.some(o => o.id === e.serviceId && o.version === e.serviceVersion));
  // Latest outcome per service/scope; equal-time conflicts are not guessed away.
  const latest = new Map<string, Experience>();
  for (const e of relevant) {
    const old = latest.get(scope(e));
    assert(!old || old.recordedAt !== e.recordedAt || old.verdict === e.verdict, 'MEMORY_CONFLICT');
    if (!old || time(e.recordedAt) > time(old.recordedAt)) latest.set(scope(e), e);
  }
  return [...latest.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId)).slice(0, 6);
}
