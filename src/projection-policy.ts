import type { Context, Decision, Experience, Task } from './domain.ts';
import { applicable } from './memory.ts';
import { fieldFailureRelevance } from './field-failure.ts';

export const PROJECTION_POLICY = 'controlled-projection-v1';
export type CycleOptions = { projectionPolicy?: typeof PROJECTION_POLICY };

// Input has already passed complete namespace/revision validation and scope/cutoff selection.
export function controlledMemory(task: Task, scoped: Experience[]) {
  const excluded = scoped.filter(e => fieldFailureRelevance(e, task) === 'irrelevant_field');
  const excludedIds = new Set(excluded.map(e => e.id));
  return { memories: scoped.filter(e => !excludedIds.has(e.id)),
    trace: { version: PROJECTION_POLICY, scope: 'CONTROLLED_DEMO_PROJECTIONS_ONLY',
      applicableMemoryIds: scoped.map(e => e.id), excludedAsIrrelevantIds: excluded.map(e => e.id) } };
}
export function knownFieldFailureIds(context: Context, proposal: Decision): string[] {
  if (proposal.serviceId === null) return [];
  // Defensive scope/version/time check even if called independently of cycle.
  return applicable(context.memories, context.task, context.offers)
    .filter(e => e.serviceId === proposal.serviceId && fieldFailureRelevance(e, context.task) === 'relevant_failure')
    .map(e => e.id);
}
