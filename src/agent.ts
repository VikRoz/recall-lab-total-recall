import { assert, compatible, decision, integer, validateTask, verify } from './domain.ts';
import { applicable, completeMemory } from './memory.ts';
import type { Context, Decision, Experience, ModelPort, Offer, Result, Snapshot, Task } from './domain.ts';
import type { MemoryPort } from './memory.ts';
import { controlledMemory, knownFieldFailureIds, PROJECTION_POLICY } from './projection-policy.ts';
import type { CycleOptions } from './projection-policy.ts';

// Useful baseline, explicitly not a language model.
export function deterministicSelect(context: Context): Decision {
  const offers = context.offers.filter(o => compatible(context.task, o))
    .sort((a, b) => integer(a.price) < integer(b.price) ? -1 : integer(a.price) > integer(b.price) ? 1 : a.id.localeCompare(b.id));
  const usable = offers.filter(o => !context.memories.some(e => e.serviceId === o.id && e.serviceVersion === o.version && e.verdict === 'fail'));
  const chosen = usable[0];
  return {
    serviceId: chosen?.id ?? null,
    reason: chosen ? 'Lowest demo price among compatible offers without a matching known failure.' : 'No compatible offer without a matching known failure.',
    memoryIds: context.memories.filter(e => offers.some(o => o.id === e.serviceId)).map(e => e.id),
  };
}
export type CyclePorts = {
  model: ModelPort; memory: MemoryPort;
  serviceScope?: 'controlled-demo-projection';
  service(offer: Offer, task: Task): Promise<Result>;
  reference(result: Result, task: Task): Promise<Snapshot>;
};
// Provider effects are separated from planning. Durable write submission lives in outbox.ts.
// No reference/oracle is present in Context, and no second purchase or model repair occurs.
export async function cycle(task: Task, offers: Offer[], ports: CyclePorts, useMemory: boolean, options: CycleOptions = {}) {
  validateTask(task);
  assert(offers.length > 0 && offers.length <= 3 && new Set(offers.map(o => o.id)).size === offers.length, 'INVALID_CATALOG');
  const controlled = options.projectionPolicy !== undefined;
  assert(!controlled || options.projectionPolicy === PROJECTION_POLICY, 'PROJECTION_POLICY_INVALID');
  assert(!controlled || ports.serviceScope === 'controlled-demo-projection', 'CONTROLLED_PROJECTION_SCOPE_REQUIRED');
  if (controlled) { task = structuredClone(task); offers = structuredClone(offers); }
  const all = useMemory ? await completeMemory(ports.memory) : [];
  const scoped = applicable(all, task, offers);
  const policy = controlled ? controlledMemory(task, scoped) : undefined;
  const memories = policy ? policy.memories : scoped;
  const context: Context = { task, offers, memories };
  const parsed = decision(await ports.model.select(controlled ? structuredClone(context) : context), context);
  const selected = controlled ? structuredClone(parsed) : parsed;
  const base = { mode: ports.model.mode, memoryMode: useMemory ? ports.memory.mode : 'off', decision: selected, memoryIds: memories.map(x => x.id) };
  const evidenceIds = policy ? knownFieldFailureIds(context, selected) : [];
  const annotated = policy ? { ...base, projectionPolicy: { ...policy.trace,
    providedMemoryIds: memories.map(e => e.id), guardEvidenceIds: evidenceIds } } : base;
  if (selected.serviceId === null) return { ...annotated, status: 'DECLINED' as const };
  if (evidenceIds.length) return { ...annotated, status: 'BLOCKED' as const, blockReason: 'KNOWN_REQUIRED_FIELD_FAILURE' as const };
  const offer = offers.find(o => o.id === selected.serviceId)!;
  const result = await ports.service(offer, task);
  const ref = await ports.reference(result, task);
  const verification = verify(task, offer, result, ref);
  return { ...annotated, status: 'VERIFIED' as const, result, verification };
}
export function observation(task: Task, output: Awaited<ReturnType<typeof cycle>>, now: string): Experience {
  assert(output.status === 'VERIFIED', 'NO_OBSERVATION');
  return {
    schema: 1, kind: 'experience', id: 'experience:' + task.id,
    network: task.network, family: task.family, serviceId: output.result.serviceId,
    serviceVersion: output.result.serviceVersion, recordedAt: now, observedAt: task.cutoff,
    verdict: output.verification.status, reasons: output.verification.reasons, supersedes: null,
    evidence: { source: output.result.source, target: task.target, version: output.result.version },
  };
}
