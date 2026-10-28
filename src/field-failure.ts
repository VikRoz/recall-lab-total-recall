import type { Experience, Task } from './domain.ts';

export type FieldFailureRelevance = 'relevant_failure' | 'irrelevant_field' | 'unassessable';
// Only structured field reasons can support this limited demo risk rule.
export function fieldFailureRelevance(record: Experience, task: Task): FieldFailureRelevance {
  const fields = record.reasons.map(r => /^(?:missing|mismatch):([a-zA-Z0-9][a-zA-Z0-9:_-]{0,119})$/.exec(r)?.[1]);
  if (record.verdict === 'fail' && fields.some(f => f && task.requiredFields.includes(f))) return 'relevant_failure';
  if (record.verdict === 'fail' && fields.length > 0 && fields.every(Boolean)) return 'irrelevant_field';
  return 'unassessable';
}
