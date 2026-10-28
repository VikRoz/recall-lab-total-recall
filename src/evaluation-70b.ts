import { assert } from './domain.ts';
import { hash } from './evaluation.ts';
import type { EvaluationCase } from './evaluation.ts';
import { modelRequestV2, prepareV2 } from './evaluation-v2.ts';
import { MODEL_70B_ID } from './providers/model.ts';

// Evaluator-only transport envelope handling. Decision/schema validation remains mandatory.
export function unwrapEvaluatorJson(raw: unknown) {
  if (typeof raw !== 'string' || !raw.startsWith('```')) return { value: raw, envelopeRemoved: false };
  const match = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(raw);
  assert(match, 'EVALUATOR_ENVELOPE_INVALID');
  JSON.parse(match[1]); // Exactly one JSON value; no repair or extraction from prose.
  return { value: match[1], envelopeRemoved: true };
}

export function request70b(context: Parameters<typeof modelRequestV2>[0]) {
  const request = { modelId: MODEL_70B_ID, body: modelRequestV2(context) };
  return { request, key: hash(request) };
}
export async function prepare70b(cases: EvaluationCase[], blobId: string) {
  const original = await prepareV2(cases, blobId);
  const plan = original.plan.map(p => ({ ...p, ...request70b(p.context) }));
  const uniqueKeys = [...new Set(plan.map(p => p.key))].sort();
  assert(uniqueKeys.length === 5, 'MODEL70B_PLAN_INVALID');
  return { controls: original.controls, plan, uniqueKeys };
}
export function pairImproved(rows: any[], memoryId: string) {
  const [off, on] = rows;
  return rows.length >= 2 && off.memoryEnabled === false && on.memoryEnabled === true
    && off.verdict === 'fail' && on.verdict === 'pass'
    && on.decision?.memoryIds.includes(memoryId) === true;
}
export async function run70bPlan(
  prepared: Awaited<ReturnType<typeof prepare70b>>, memoryId: string,
  invoke: (condition: Awaited<ReturnType<typeof prepare70b>>['plan'][number]) => Promise<any>,
) {
  const rows = [];
  for (let i = 0; i < prepared.plan.length; i++) {
    if (i === 2 && !pairImproved(rows, memoryId)) return { rows, pairImproved: false };
    rows.push(await invoke(prepared.plan[i]));
  }
  return { rows, pairImproved: pairImproved(rows, memoryId) };
}
