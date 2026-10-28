import { createHash } from 'node:crypto';
import { cycle, deterministicSelect } from './agent.ts';
import { canonical, Fault, integer } from './domain.ts';
import type { Context, Experience, ModelPort, Offer, Result, Snapshot, Task } from './domain.ts';
import type { MemoryPort } from './memory.ts';
import type { CycleOptions } from './projection-policy.ts';

export function hash(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export type EvaluationCase = {
  id: string; purpose: string; task: Task; offers: Offer[];
  reference: Snapshot; results: Result[]; records: Experience[];
};

// A frozen, read-only corpus. 'origin' describes the provider, not a fresh read per arm.
export class FrozenMemory implements MemoryPort {
  mode: 'fixture' | 'live'; records: Experience[]; blobIds: string[]; revision: string;
  constructor(records: Experience[], origin: 'fixture' | 'live' = 'fixture', blobIds?: string[]) {
    this.records = structuredClone(records); this.mode = origin;
    this.blobIds = blobIds ?? records.map((_, i) => 'synthetic-record:' + i);
    if (this.blobIds.length !== records.length) throw new Fault('EVALUATION_MEMORY_MAPPING_INVALID');
    this.revision = hash({ records: this.records, blobIds: this.blobIds });
  }
  async inventory() { return { blobIds: [...this.blobIds], revision: this.revision }; }
  async recall(_query: string, limit: number) {
    return this.records.slice(0, limit).map((record, i) => ({ blobId: this.blobIds[i], text: canonical(record) }));
  }
  async remember(_text: string, _key: string): Promise<never> { throw new Fault('EVALUATION_READ_ONLY'); }
  async status(_jobId: string): Promise<never> { throw new Fault('EVALUATION_READ_ONLY'); }
}

export const deterministicModel: ModelPort = {
  mode: 'fixture', async select(context) { return deterministicSelect(context); },
};

export async function evaluateArm(input: EvaluationCase, model: ModelPort, memory: MemoryPort, enabled: boolean, options: CycleOptions = {}) {
  const c = structuredClone(input);
  let context: Context | undefined; let selections = 0; let serviceProjections = 0;
  let selected: string | null = null;
  try {
    const output = await cycle(c.task, c.offers, {
      memory,
      ...(options.projectionPolicy ? { serviceScope: 'controlled-demo-projection' as const } : {}),
      model: { mode: model.mode, select: async current => {
        selections++; context = structuredClone(current);
        return model.select(structuredClone(current));
      } },
      service: async offer => {
        selected = offer.id; serviceProjections++;
        const result = c.results.find(r => r.serviceId === offer.id && r.serviceVersion === offer.version);
        if (!result) throw new Fault('EVALUATION_RESULT_MISSING');
        return structuredClone(result);
      },
      reference: async () => structuredClone(c.reference),
    }, enabled, options);
    return {
      caseId: c.id, memoryEnabled: enabled, selectorMode: model.mode,
      context, contextHash: hash(context), selections, serviceProjections,
      selectedServiceId: options.projectionPolicy ? selected : output.decision.serviceId, decision: output.decision,
      memoryIdsAvailable: output.memoryIds,
      verdict: output.status === 'VERIFIED' ? output.verification.status : 'declined' as const,
      reasons: output.status === 'VERIFIED' ? output.verification.reasons : output.status === 'BLOCKED' ? [output.blockReason] : [],
      demoCredits: selected ? c.offers.find(o => o.id === selected)!.price : '0',
      ...(options.projectionPolicy ? { proposedServiceId: output.decision.serviceId, executionStatus: output.status,
        controllerEvidence: 'projectionPolicy' in output ? output.projectionPolicy : null } : {}),
    };
  } catch (error) {
    return {
      caseId: c.id, memoryEnabled: enabled, selectorMode: model.mode,
      context, contextHash: context ? hash(context) : null, selections, serviceProjections,
      selectedServiceId: selected, decision: null, memoryIdsAvailable: context?.memories.map(e => e.id) ?? [],
      verdict: 'error' as const,
      reasons: [error instanceof Fault ? error.code : error instanceof SyntaxError ? 'MODEL_JSON_INVALID' : 'EVALUATION_FAILED'],
      demoCredits: selected ? c.offers.find(o => o.id === selected)!.price : '0',
      ...(options.projectionPolicy ? { proposedServiceId: null, executionStatus: 'ERROR' as const, controllerEvidence: null } : {}),
    };
  }
}

export function summarize(rows: Awaited<ReturnType<typeof evaluateArm>>[]) {
  const counts = { pass: 0, fail: 0, unknown: 0, declined: 0, error: 0 };
  let credits = 0n;
  for (const row of rows) { counts[row.verdict]++; credits += integer(row.demoCredits); }
  return { ...counts, runs: rows.length, totalDemoCredits: String(credits),
    demoCreditsPerPass: counts.pass ? { numerator: String(credits), denominator: counts.pass } : null };
}
