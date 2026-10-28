// A bounded diagnostic over the exact prepared requests. No Tatum/Walrus or action execution.
import { assert, canonical, Fault } from './domain.ts';
import { hash } from './evaluation.ts';
import { MODEL_ID, modelRequest } from './providers/model.ts';
import { gradeScenarioProposal } from './memory-scenario.ts';
import { assessCitations } from './citations.ts';
import type { Journal } from './local-journal.ts';
export const SCENARIO_INPUT_PLAN_HASH = '01a44fea2996b2881db7defeaee182c93536a5a2432658b32b9ab758746389f5';
export const PROBE_PREFIX = 'eval:scenario-probe:v1:';
export function probePermit(prepared: any, binding: { accountIdHash: string; sourceHash: string; runtimeImageId: string }) {
  assert(hash(prepared.plan) === SCENARIO_INPUT_PLAN_HASH && prepared.plan.providerCallsAllowed === 0
    && prepared.plan.requests.length === 5, 'PROBE_PREPARED_INPUT_CHANGED');
  return { schema: 1, status: 'PREPARED_NOT_AUTHORIZED', inputPlanHash: SCENARIO_INPUT_PLAN_HASH,
    preparedReportHash: hash(prepared), scenarioHash: prepared.plan.scenarioHash, modelId: MODEL_ID,
    requestKeys: prepared.plan.requests.map((x: any) => x.key), maxNewModelCalls: 5,
    maxInputMessagesBytes: 3500, maxOutputTokens: 512, temperature: 0,
    responseParser: 'STRICT_DEFAULT_V1_UNCHANGED', tatumCalls: 0, walrusOperations: 0,
    additionalSpendLimitUSD: 0, retries: 0, accountIdHash: binding.accountIdHash,
    sourceHash: binding.sourceHash, runtimeImageId: binding.runtimeImageId };
}
export function authorizeProbe(prepared: any, permit: any, env: Record<string, string | undefined>) {
  // Only the three public binding values may be injected into the permit factory.
  const expected = probePermit(prepared, { accountIdHash: permit.accountIdHash,
    sourceHash: permit.sourceHash, runtimeImageId: permit.runtimeImageId });
  assert(canonical(permit) === canonical(expected)
    && /^[a-f0-9]{64}$/.test(permit.accountIdHash) && /^[a-f0-9]{64}$/.test(permit.sourceHash)
    && /^sha256:[a-f0-9]{64}$/.test(permit.runtimeImageId), 'PROBE_BINDING_INVALID');
  const permitHash = hash(permit);
  assert(env.RECALL_SCENARIO_PROBE_APPROVED_HASH === permitHash
    && env.RECALL_SCENARIO_PROBE_ZERO_SPEND_HASH === permitHash, 'PROBE_NEW_APPROVAL_REQUIRED');
  assert(env.RECALL_FREE_TIER_CONFIRMED === 'true' && env.RECALL_RUNTIME_IMAGE_ID === permit.runtimeImageId
    && env.RECALL_PROBE_SOURCE_HASH === permit.sourceHash, 'PROBE_FREE_RUNTIME_REQUIRED');
  assert(env.CLOUDFLARE_ACCOUNT_ID && /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID)
    && hash(env.CLOUDFLARE_ACCOUNT_ID) === permit.accountIdHash && env.CLOUDFLARE_API_TOKEN, 'PROBE_CREDENTIALS_INVALID');
  assert(!env.TATUM_API_KEY && !env.MEMWAL_KEY && !env.MEMWAL_ACCOUNT_ID, 'PROBE_EXCESS_CREDENTIALS');
  return permitHash;
}
export function scoreProbe(prepared: any, scenario: any, responses: Map<string, unknown>) {
  assert(hash(scenario) === prepared.plan.scenarioHash, 'PROBE_SCENARIO_CHANGED');
  return prepared.stages.map((row: any) => {
    const stage = scenario.stages.find((x: any) => x.id === row.id);
    const arms = row.modelArms.map((arm: any) => {
      if (!responses.has(arm.requestHash)) return { condition: arm.condition, requestHash: arm.requestHash, status: 'NOT_RUN' };
      const raw = responses.get(arm.requestHash), context = JSON.parse(arm.request.body.messages[1].content);
      try {
        const graded = gradeScenarioProposal(stage, context, raw);
        return { condition: arm.condition, requestHash: arm.requestHash, status: 'MODEL_RESPONSE_SCORED',
          rawResponseHash: hash(raw), ...graded, citationAudit: assessCitations(context, graded.proposal) };
      } catch (error) {
        return { condition: arm.condition, requestHash: arm.requestHash, status: 'MODEL_RESPONSE_INVALID',
          rawResponseHash: hash(raw), goalCompleted: false,
          code: error instanceof Fault ? error.code : error instanceof SyntaxError ? 'MODEL_JSON_INVALID' : 'PROBE_GRADING_FAILED' };
      }
    });
    return { id: row.id, label: row.label, arms, D: row.D,
      BAndCShareOneResponse: row.modelArms[1].requestHash === row.modelArms[2].requestHash };
  });
}
export async function executeProbe(options: {
  prepared: any; scenario: any; permit: any; env: Record<string, string | undefined>; journal: Journal;
  invoke(request: any): Promise<unknown>; progress(value: any): void;
}) {
  const { prepared, scenario, permit, env, journal: j } = options;
  const permitHash = authorizeProbe(prepared, permit, env);
  assert(hash(scenario) === prepared.plan.scenarioHash, 'PROBE_SCENARIO_CHANGED');
  const old = j.db.prepare('SELECT id,state,hash FROM effects').all() as any[];
  assert(old.length === 0 && (j.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as any).n === 0, 'PROBE_JOURNAL_NOT_FRESH');
  const responses = new Map<string, unknown>(); let calls = 0;
  const snapshot = (status: string, code: string | null = null) => ({ status, code, permitHash,
    inputPlanHash: SCENARIO_INPUT_PLAN_HASH, modelId: MODEL_ID, requestsReserved: (j.db.prepare('SELECT COUNT(*) AS n FROM effects').get() as any).n,
    modelCallsThisInvocation: calls, completedUniqueResponses: responses.size, logicalArms: 9,
    rows: scoreProbe(prepared, scenario, responses), tatumCalls: 0, walrusOperations: 0, additionalSpendLimitUSD: 0,
    limitations: ['One known development scenario with two controls, not a general performance estimate.',
      'B/C and the irrelevant-field arms reuse identical request outputs; they are not independent trials.',
      'Service results/reference/memory are saved controlled projections, not fresh chain reads or purchases.',
      'Raw model proposals, controller admission and deterministic D remain separate.'] });
  try {
    for (const entry of prepared.plan.requests) {
      assert(calls < 5 && permit.requestKeys[calls] === entry.key && hash(entry.request) === entry.key
        && entry.request.modelId === MODEL_ID, 'PROBE_REQUEST_PLAN_CHANGED');
      const context = JSON.parse(entry.request.body.messages[1].content);
      assert(canonical(modelRequest(context)) === canonical(entry.request.body), 'PROBE_PROMPT_CHANGED');
      const raw = await j.once(PROBE_PREFIX + entry.key, 'model', entry.request, async () => {
        calls++;
        return options.invoke(entry.request);
      });
      responses.set(entry.key, raw);
      options.progress(snapshot('SCENARIO_PROBE_RUNNING'));
    }
    return snapshot('SCENARIO_PROBE_COMPLETED');
  } catch (error) {
    const result = snapshot('SCENARIO_PROBE_STOPPED', error instanceof Fault ? error.code : 'PROBE_FAILED');
    options.progress(result);
    return result;
  }
}
