export type Network = 'mainnet' | 'testnet';
export type Verdict = 'pass' | 'fail' | 'unknown';
export type Task = {
  id: string; network: Network; family: string; target: string;
  requiredFields: string[]; maxAgeMs: number; budget: string; cutoff: string;
};
export type Offer = {
  id: string; version: string; network: Network; families: string[];
  fields: string[]; price: string;
};
export type Snapshot = {
  network: Network; target: string; version: string; asOf: string;
  fields: Record<string, string>; source: 'fixture' | 'tatum';
};
export type Result = Snapshot & { serviceId: string; serviceVersion: string };
export type Verification = { status: Verdict; reasons: string[] };
export type Experience = {
  schema: 1; kind: 'experience'; id: string; network: Network;
  family: string; serviceId: string; serviceVersion: string;
  recordedAt: string; observedAt: string; verdict: Verdict; reasons: string[];
  supersedes: string | null; evidence: { source: 'fixture' | 'tatum'; target: string; version: string };
};
export type Decision = { serviceId: string | null; reason: string; memoryIds: string[] };
export type Context = { task: Task; offers: Offer[]; memories: Experience[] };
export type ModelPort = { mode: 'fixture' | 'live'; select(context: Context): Promise<unknown> };
export class Fault extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'Fault'; this.code = code; }
}
export function assert(ok: unknown, code: string): asserts ok { if (!ok) throw new Fault(code); }
export function integer(s: unknown): bigint {
  assert(typeof s === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(s), 'INVALID_INTEGER');
  return BigInt(s);
}
export function time(s: unknown): number {
  assert(typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s), 'INVALID_TIME');
  const n = Date.parse(s); assert(Number.isFinite(n), 'INVALID_TIME');
  assert(new Date(n).toISOString() === (s.length === 20 ? s.replace('Z', '.000Z') : s), 'INVALID_TIME'); return n;
}
export function object(v: unknown): Record<string, any> {
  assert(v !== null && typeof v === 'object' && !Array.isArray(v), 'INVALID_OBJECT');
  return v as Record<string, any>;
}
export function exactKeys(v: Record<string, any>, names: string[]) {
  assert(Object.keys(v).sort().join('|') === [...names].sort().join('|'), 'INVALID_KEYS');
}
export function id(v: unknown): asserts v is string {
  assert(typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/.test(v), 'INVALID_ID');
}
export function validateTask(t: Task) {
  id(t.id); id(t.family);
  assert(t.network === 'mainnet' || t.network === 'testnet', 'WRONG_NETWORK');
  assert(typeof t.target === 'string' && t.target.length > 0 && t.target.length <= 160, 'INVALID_TARGET');
  assert(Array.isArray(t.requiredFields) && t.requiredFields.length > 0 && t.requiredFields.length <= 8, 'INVALID_FIELDS');
  for (const f of t.requiredFields) id(f);
  assert(new Set(t.requiredFields).size === t.requiredFields.length, 'INVALID_FIELDS');
  assert(Number.isSafeInteger(t.maxAgeMs) && t.maxAgeMs >= 0, 'INVALID_AGE');
  integer(t.budget); time(t.cutoff);
}
export function compatible(task: Task, offer: Offer): boolean {
  return offer.network === task.network && offer.families.includes(task.family)
    && task.requiredFields.every(f => offer.fields.includes(f)) && integer(offer.price) <= integer(task.budget);
}
export function decision(raw: unknown, context: Context): Decision {
  const d = object(typeof raw === 'string' ? JSON.parse(raw) : raw);
  exactKeys(d, ['serviceId', 'reason', 'memoryIds']);
  assert(d.serviceId === null || typeof d.serviceId === 'string', 'MODEL_INVALID');
  assert(typeof d.reason === 'string' && d.reason.length > 0 && d.reason.length <= 800, 'MODEL_INVALID');
  assert(Array.isArray(d.memoryIds) && d.memoryIds.length <= 6 && new Set(d.memoryIds).size === d.memoryIds.length, 'MODEL_INVALID');
  assert(d.memoryIds.every((m: unknown) => context.memories.some(x => x.id === m)), 'UNKNOWN_MEMORY_REFERENCE');
  if (d.serviceId !== null) {
    const offer = context.offers.find(x => x.id === d.serviceId);
    assert(offer && compatible(context.task, offer), 'ACTION_BLOCKED');
  }
  return d as Decision;
}
export function verify(task: Task, offer: Offer, result: Result, ref: Snapshot): Verification {
  const reasons: string[] = [];
  if (result.network !== task.network || ref.network !== task.network) reasons.push('wrong-network');
  if (result.target !== task.target || ref.target !== task.target) reasons.push('wrong-target');
  if (result.serviceId !== offer.id || result.serviceVersion !== offer.version) reasons.push('wrong-offer');
  const age = time(task.cutoff) - time(result.asOf);
  if (age < 0 || age > task.maxAgeMs) reasons.push('outside-time-window');
  for (const f of task.requiredFields) if (typeof result.fields[f] !== 'string') reasons.push(`missing:${f}`);
  if (reasons.length) return { status: 'fail', reasons };
  if (result.version !== ref.version) return { status: 'unknown', reasons: ['reference-version-mismatch'] };
  for (const f of task.requiredFields) {
    if (typeof ref.fields[f] !== 'string') return { status: 'unknown', reasons: ['reference-incomplete'] };
    if (result.fields[f] !== ref.fields[f]) reasons.push(`mismatch:${f}`);
  }
  return { status: reasons.length ? 'fail' : 'pass', reasons };
}
export function experience(raw: unknown): Experience {
  const e = object(raw);
  exactKeys(e, ['schema', 'kind', 'id', 'network', 'family', 'serviceId', 'serviceVersion', 'recordedAt', 'observedAt', 'verdict', 'reasons', 'supersedes', 'evidence']);
  assert(e.schema === 1 && e.kind === 'experience', 'MEMORY_SCHEMA_INVALID');
  for (const k of ['id', 'family', 'serviceId', 'serviceVersion']) id(e[k]);
  assert(e.network === 'mainnet' || e.network === 'testnet', 'MEMORY_SCHEMA_INVALID');
  time(e.recordedAt); time(e.observedAt);
  assert(time(e.observedAt) <= time(e.recordedAt), 'MEMORY_TIME_INVALID');
  assert(['pass', 'fail', 'unknown'].includes(e.verdict), 'MEMORY_SCHEMA_INVALID');
  assert(Array.isArray(e.reasons) && e.reasons.length <= 12 && e.reasons.every((x: unknown) => typeof x === 'string' && x.length <= 160), 'MEMORY_SCHEMA_INVALID');
  if (e.supersedes !== null) id(e.supersedes);
  const ev = object(e.evidence); exactKeys(ev, ['source', 'target', 'version']);
  assert(['fixture', 'tatum'].includes(ev.source) && typeof ev.target === 'string' && ev.target.length <= 160 && typeof ev.version === 'string' && ev.version.length <= 160, 'MEMORY_SCHEMA_INVALID');
  return e as Experience;
}
export function scope(e: Experience): string {
  return [e.network, e.family, e.serviceId, e.serviceVersion].join('/');
}
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  return JSON.stringify(v);
}
