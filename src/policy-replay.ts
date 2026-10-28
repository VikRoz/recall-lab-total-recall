import { assert, canonical, decision, Fault } from './domain.ts';
import { buildEvaluationPlan } from './evaluation-plan.ts';
import { evaluateArm, FrozenMemory, hash } from './evaluation.ts';
import { modelRequestV2 } from './evaluation-v2.ts';
import { MODEL_70B_ID } from './providers/model.ts';
import { PROJECTION_POLICY } from './projection-policy.ts';

export const RECORDED_BENCHMARK_REPORT_HASH = 'c0982acff159846eb5b418996cb3f3fabb088679b951a9f587c416ef63f17199';
// No inference. Only identical recorded request bodies may supply a historical decision.
export async function replayPolicy(source: any, expectedSourceHash = RECORDED_BENCHMARK_REPORT_HASH) {
  assert(hash(source) === expectedSourceHash, 'POLICY_REPLAY_SOURCE_HASH_MISMATCH');
  const plan = await buildEvaluationPlan();
  assert(source?.status === 'BENCHMARK_COMPLETED' && source.mode === 'LIVE_MODEL_SYNTHETIC_INPUTS'
    && source.planHash === hash(plan) && source.modelId === MODEL_70B_ID && source.rows?.length === 32,
  'POLICY_REPLAY_SOURCE_INVALID');
  const cache = new Map<string, { decision: unknown; rawResponseHash: string; sources: string[] }>();
  for (const row of source.rows) {
    const original = plan.conditions.find(c => c.caseId === row.caseId && c.memoryEnabled === row.memoryEnabled);
    assert(original && original.key === row.requestKey && canonical(original.context) === canonical(row.context)
      && row.decision && typeof row.rawResponseHash === 'string' && /^[a-f0-9]{64}$/.test(row.rawResponseHash), 'POLICY_REPLAY_SOURCE_MISMATCH');
    const parsed = decision(row.decision, original.context), old = cache.get(row.requestKey);
    assert(!old || canonical(old.decision) === canonical(parsed) && old.rawResponseHash === row.rawResponseHash,
      'POLICY_REPLAY_CACHE_CONFLICT');
    if (old) old.sources.push(row.caseId + ':' + (row.memoryEnabled ? 'on' : 'off'));
    else cache.set(row.requestKey, { decision: structuredClone(parsed), rawResponseHash: row.rawResponseHash,
      sources: [row.caseId + ':' + (row.memoryEnabled ? 'on' : 'off')] });
  }
  assert(cache.size === plan.callLimit, 'POLICY_REPLAY_SOURCE_INCOMPLETE');
  const rows = [];
  for (const condition of plan.conditions) {
    let key = '', matched = false;
    const input = plan.cases.find(c => c.id === condition.caseId)!;
    const row = await evaluateArm(input, { mode: 'fixture', select: async context => {
      key = hash({ modelId: MODEL_70B_ID, body: modelRequestV2(context) });
      const stored = cache.get(key);
      if (!stored) throw new Fault('RECORDED_REQUEST_NOT_FOUND');
      matched = true; return structuredClone(stored.decision);
    } }, new FrozenMemory(input.records), condition.memoryEnabled, { projectionPolicy: PROJECTION_POLICY });
    const stored = cache.get(key);
    rows.push({ ...row, ...(matched ? {} : { verdict: 'not_run', reasons: ['NO_EXACT_RECORDED_REQUEST'] }),
      replayStatus: matched ? 'matched_exact_request' : 'not_run_changed_request', requestKey: key,
      sourceConditions: stored?.sources ?? [], sourceRawResponseHash: stored?.rawResponseHash ?? null });
  }
  return { status: 'POLICY_REPLAY_COMPLETED', mode: 'RECORDED_DECISION_REPLAY_ONLY', policy: PROJECTION_POLICY,
    sourcePlanHash: hash(plan), sourceReportHash: hash(source), modelCalls: 0, tatumCalls: 0, walrusOperations: 0,
    completedReplayArms: rows.filter(r => r.replayStatus === 'matched_exact_request').length,
    notRunChangedArms: rows.filter(r => r.replayStatus !== 'matched_exact_request').length, rows,
    limitations: ['No fresh model inference; a repeated decision under an identical request is replay, not an independent sample.',
      'Changed request without an exact source match is not run; no fixture answer is substituted.'] };
}
