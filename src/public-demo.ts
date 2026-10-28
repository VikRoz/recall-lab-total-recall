// Public, read-only projection over independently checked saved evidence.
import { assert, canonical } from './domain.ts';
import { hash } from './evaluation.ts';
import { scoreProbe, SCENARIO_INPUT_PLAN_HASH, PROBE_PREFIX } from './scenario-probe.ts';

export const PUBLIC_MODEL_REPORT_HASH = '36b5f462e753b8af3f98dec355ceeaa94fb0bb27bd6a0eb8d1e3ca7fdd17c22d';
export const PUBLIC_PROBE_PERMIT_HASH = '40f12edf62f0c12d48445244f99d32a576b5b0ce70d555896a788f8624ee743d';
export function publicDemoData(rehearsal: any, prepared: any, scenario: any, permit: any, live: any) {
  assert(hash(live) === PUBLIC_MODEL_REPORT_HASH && hash(permit) === PUBLIC_PROBE_PERMIT_HASH,
    'PUBLIC_DEMO_MODEL_EVIDENCE_CHANGED');
  assert(hash(prepared) === permit.preparedReportHash && hash(prepared.plan) === SCENARIO_INPUT_PLAN_HASH
    && hash(scenario) === permit.scenarioHash, 'PUBLIC_DEMO_INPUTS_CHANGED');
  assert(live.status === 'SCENARIO_PROBE_COMPLETED' && live.permitHash === hash(permit)
    && live.effects.length === permit.maxNewModelCalls && live.modelCallsThisInvocation === 5
    && live.tatumCalls === 0 && live.walrusOperations === 0, 'PUBLIC_DEMO_RUN_INCOMPLETE');
  const responses = new Map<string, unknown>();
  for (const [i, effect] of live.effects.entries()) {
    const request = prepared.plan.requests[i];
    assert(effect.id === PROBE_PREFIX + request.key && effect.hash === hash(request.request)
      && effect.state === 'DONE' && effect.kind === 'model', 'PUBLIC_DEMO_EFFECT_CHANGED');
    responses.set(request.key, JSON.parse(effect.response));
  }
  const rows = scoreProbe(prepared, scenario, responses);
  assert(canonical(rows) === canonical(live.rows), 'PUBLIC_DEMO_SCORE_CHANGED');
  assert(rehearsal.status === 'UNIFIED_TEN_RECORD_REHEARSAL_VERIFIED'
    && rehearsal.independentProcess.checked && rehearsal.independentProcess.recordsVerified === 10
    && rehearsal.independentProcess.credentialEnvironment === 'NONE'
    && rehearsal.independentProcess.remoteRecallThisRun === false, 'PUBLIC_DEMO_REHEARSAL_INCOMPLETE');
  const records = rehearsal.coverage.records;
  assert(records.length === 10 && new Set(records.map((r: any) => r.id)).size === 10
    && records.every((r: any) => r.receipt && ['done', 'DONE'].includes(r.receipt.state)), 'PUBLIC_DEMO_RECEIPTS_MISSING');
  const chains = records.filter((r: any) => r.record.supersedes).map((r: any) => {
    const parent = records.find((p: any) => p.id === r.record.supersedes);
    assert(parent, 'PUBLIC_DEMO_PARENT_MISSING');
    return { scope: `${r.record.serviceId}/${r.record.family}/${r.record.serviceVersion}`,
      parentId: parent.id, correctionId: r.id, before: parent.record.verdict, after: r.record.verdict,
      source: r.record.evidence.source };
  });
  assert(chains.length === 5, 'PUBLIC_DEMO_CHAIN_COUNT');
  return {
    schema: 1, mode: 'SAVED_EVIDENCE_REPLAY', savedModelRunDate: '2026-10-28', savedMemoryReadDate: '2026-10-27',
    modelId: live.modelId, providerCallsThisBuild: 0, newMainnetWrites: 0, additionalSpendUSD: 0,
    savedUniqueModelCalls: responses.size, logicalModelArms: 9, records, chains,
    historicalNegativePilot: rehearsal.recordedModelCaveat,
    totals: Object.fromEntries(['A', 'B', 'C', 'D'].map(c => [c, rows.reduce((n: number, row: any) =>
      n + Number(c === 'D' ? row.D.goalCompleted : row.arms.find((a: any) => a.condition === c).goalCompleted), 0)])),
    stages: rows.map((row: any, i: number) => {
      const context = JSON.parse(prepared.stages[i].modelArms[0].request.body.messages[1].content);
      return { ...row, task: context.task, offers: context.offers,
        rawResponses: Object.fromEntries(row.arms.map((arm: any) => [arm.condition, responses.get(arm.requestHash)])) };
    }),
    localVerification: { freshProcess: true, records: 10, credentials: 'NONE', remoteRecall: false,
      description: 'Fresh local process verified saved blobs/revisions; earlier separate live readers verified Mainnet.' },
    provenance: { modelReportHash: hash(live), permitHash: hash(permit), inputPlanHash: SCENARIO_INPUT_PLAN_HASH,
      originalMemoryInputHash: rehearsal.evidenceHash, coverageInputHash: rehearsal.coverage.coverageEvidenceHash,
      modelInference: 'SAVED_REAL_8B_V1_RESPONSES', projectionEvaluation: 'RECOMPUTED_LOCALLY_FROM_SAVED_CONTROLLED_DATA',
      deterministicBaseline: 'PREVIOUSLY_EXECUTED_OFFLINE', memoryRead: 'SAVED_REAL_MAINNET_READ_PLUS_LOCAL_RESTORATION' },
  };
}
