// Shared, pure context preparation. No oracle, provider, SQLite or credential access.
import { assert, canonical, exactKeys, experience, validateTask } from './domain.ts';
import type { Experience, Offer, Task } from './domain.ts';
import { applicable, completeMemory } from './memory.ts';
import type { MemoryPort } from './memory.ts';
import { controlledMemory } from './projection-policy.ts';
import { hash } from './evaluation.ts';

export type SavedSnapshot = {
  schema: 1; mode: 'SAVED_WALRUS_BYTES_LOCAL_RESTORE_NOT_LIVE'; sourceEvidenceHash: string;
  manifestHash: string; entries: { id: string; blobId: string; hash: string }[];
  hits: { blobId: string; text: string }[];
};
export type RestoreRequest = {
  schema: 1; stageId: string; task: Task; offers: Offer[];
  snapshotHash: string; expected: SavedSnapshot['entries'];
};
export function scenarioContext(task: Task, offers: Offer[], records: Experience[]) {
  validateTask(task);
  assert(offers.length > 0 && offers.length <= 3 && new Set(offers.map(o => o.id)).size === offers.length, 'SCENARIO_CATALOG_INVALID');
  const all = records.map(x => experience(structuredClone(x)));
  const selected = controlledMemory(task, applicable(all, task, offers));
  // Use one explicit encoding for every route; property insertion order is not an experimental treatment.
  const context = JSON.parse(canonical({ task, offers, memories: selected.memories }));
  return { context, contextHash: hash(context), trace: selected.trace, inputRecords: all.length };
}
export function validateSnapshot(raw: unknown): SavedSnapshot {
  const s = structuredClone(raw) as SavedSnapshot;
  exactKeys(s, ['schema', 'mode', 'sourceEvidenceHash', 'manifestHash', 'entries', 'hits']);
  assert(s.schema === 1 && s.mode === 'SAVED_WALRUS_BYTES_LOCAL_RESTORE_NOT_LIVE'
    && /^[a-f0-9]{64}$/.test(s.sourceEvidenceHash) && /^[a-f0-9]{64}$/.test(s.manifestHash)
    && s.entries.length === 10 && s.hits.length === 10
    && new Set(s.entries.map(x => x.id)).size === 10 && new Set(s.entries.map(x => x.blobId)).size === 10
    && new Set(s.hits.map(x => x.blobId)).size === 10, 'SCENARIO_SNAPSHOT_INVALID');
  for (const e of s.entries) {
    const hit = s.hits.find(x => x.blobId === e.blobId);
    assert(hit && Buffer.byteLength(hit.text) <= 4096, 'SCENARIO_SNAPSHOT_HIT_INVALID');
    const record = experience(JSON.parse(hit.text));
    assert(record.id === e.id && hash(record) === e.hash, 'SCENARIO_SNAPSHOT_CONTENT_CHANGED');
  }
  return s;
}
class SnapshotMemory implements MemoryPort {
  mode = 'fixture' as const;
  data: SavedSnapshot;
  constructor(data: SavedSnapshot) { this.data = structuredClone(data); }
  async inventory() { return { blobIds: this.data.entries.map(x => x.blobId), revision: hash(this.data.entries) }; }
  async recall(_query: string, limit: number) { return structuredClone(this.data.hits.slice(0, limit)); }
  async remember(): Promise<never> { throw new Error('SCENARIO_WRITE_FORBIDDEN'); }
  async status(): Promise<never> { throw new Error('SCENARIO_STATUS_FORBIDDEN'); }
}
export async function restoreScenarioContext(rawRequest: unknown, rawSnapshot: unknown) {
  const request = structuredClone(rawRequest) as RestoreRequest, snapshot = validateSnapshot(rawSnapshot);
  exactKeys(request, ['schema', 'stageId', 'task', 'offers', 'snapshotHash', 'expected']);
  assert(request.schema === 1 && hash(snapshot) === request.snapshotHash
    && canonical(request.expected) === canonical(snapshot.entries), 'SCENARIO_RESTORE_INPUT_CHANGED');
  const records = await completeMemory(new SnapshotMemory(snapshot), request.expected.map(x => x.blobId));
  const prepared = scenarioContext(request.task, request.offers, records);
  return { status: 'OFFLINE_SAVED_MEMORY_RESTORED', stageId: request.stageId, requestHash: hash(request),
    snapshotHash: hash(snapshot), restoredRecords: records.length, ...prepared,
    remoteRecallThisRun: false, providerCalls: 0 };
}
