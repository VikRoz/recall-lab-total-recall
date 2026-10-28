import { deterministicSelect } from './agent.ts';
import { Fault, canonical } from './domain.ts';
import type { Context, ModelPort, Offer, Result, Snapshot, Task } from './domain.ts';
import type { MemoryPort, Receipt } from './memory.ts';

export const offers: Offer[] = ['atlas', 'beacon', 'cipher'].map((id, i) => ({
  id, version: 'v1', network: 'mainnet', families: ['ownership', 'evidence'],
  fields: ['owner', 'objectType'], price: String(i + 1),
}));
export function task(id: string, family = 'evidence', cutoff = '2026-10-24T12:00:00.000Z'): Task {
  return { id, family, network: 'mainnet', target: 'synthetic-object-A', requiredFields: family === 'ownership' ? ['owner'] : ['owner', 'objectType'], maxAgeMs: 60000, budget: '3', cutoff };
}
export function reference(t: Task): Snapshot {
  return { network: t.network, target: t.target, version: '42', asOf: t.cutoff, fields: { owner: 'synthetic-owner', objectType: 'synthetic-type' }, source: 'fixture' };
}
export async function service(offer: Offer, t: Task): Promise<Result> {
  const snapshot = structuredClone(reference(t));
  // Hidden from the agent's catalog, disclosed to the human as fault injection.
  if (offer.id === 'atlas' && offer.version === 'v1' && t.family === 'evidence') delete snapshot.fields.objectType;
  return { ...snapshot, serviceId: offer.id, serviceVersion: offer.version };
}
export class FixtureModel implements ModelPort {
  mode = 'fixture' as const;
  async select(context: Context) { return deterministicSelect(context); }
}
export type FixtureBacking = { rows: Map<string, { text: string; key: string }>; keys: Map<string, string>; revision: number };
export function newBacking(): FixtureBacking { return { rows: new Map(), keys: new Map(), revision: 0 }; }
export class FixtureMemory implements MemoryPort {
  mode = 'fixture' as const;
  backing: FixtureBacking;
  constructor(backing: FixtureBacking = newBacking()) { this.backing = backing; }
  async inventory() { return { blobIds: [...this.backing.rows.keys()], revision: String(this.backing.revision) }; }
  async recall(_query: string, limit: number) { return [...this.backing.rows].slice(0, limit).map(([blobId, row]) => ({ blobId, text: row.text })); }
  async remember(text: string, key: string) {
    const existing = this.backing.keys.get(key);
    if (existing) {
      if (this.backing.rows.get(existing)?.text !== text) throw new Fault('IDEMPOTENCY_CONFLICT');
      return { jobId: existing };
    }
    const jobId = 'fixture:' + (this.backing.revision + 1);
    this.backing.rows.set(jobId, { text, key }); this.backing.keys.set(key, jobId); this.backing.revision++;
    return { jobId };
  }
  async status(jobId: string): Promise<Receipt> {
    return this.backing.rows.has(jobId) ? { state: 'done', jobId, blobId: jobId } : { state: 'unknown', jobId };
  }
  async seed(record: unknown) { return this.remember(canonical(record), 'seed:' + this.backing.revision); }
}
