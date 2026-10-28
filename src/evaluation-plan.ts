import { assert, canonical } from './domain.ts';
import type { Experience } from './domain.ts';
import { evaluationCorpus } from './evaluation-corpus.ts';
import { deterministicModel, evaluateArm, FrozenMemory, hash } from './evaluation.ts';
import type { EvaluationCase } from './evaluation.ts';
import { modelRequestV2, PROMPT_V2 } from './evaluation-v2.ts';
import { MODEL_70B_ID } from './providers/model.ts';
import { CITATION_CONTRACT } from './citations.ts';

// Prospective combinations, never used for prompt tuning. Synthetic, not independently blinded.
export function prospectiveCases(): EvaluationCase[] {
  const [original] = evaluationCorpus();
  const mixed = structuredClone(original);
  mixed.id = mixed.task.id = 'prospective-mixed-failures';
  mixed.purpose = 'Two failures, only one required field; cheapest remaining offer differs from blanket blacklist.';
  mixed.task.requiredFields = ['owner']; mixed.task.budget = '9';
  mixed.offers = mixed.offers.map((o, i) => ({ ...o, id: ['nova', 'lyra', 'orion'][i], price: ['9', '3', '7'][i] }));
  mixed.results = mixed.offers.map(o => ({ ...structuredClone(mixed.reference), serviceId: o.id, serviceVersion: o.version }));
  delete mixed.results[1].fields.owner; delete mixed.results[2].fields.objectType;
  const failure = (c: EvaluationCase, serviceId: string, reason: string): Experience => ({ ...structuredClone(original.records[0]),
    id: 'experience:' + c.id + ':' + serviceId, family: c.task.family, serviceId, reasons: [reason] });
  mixed.records = [failure(mixed, 'lyra', 'missing:owner'), failure(mixed, 'orion', 'missing:objectType')];

  const large = structuredClone(evaluationCorpus()[9]);
  large.id = large.task.id = 'prospective-history-integer-budget';
  large.purpose = 'Historical owner mismatch and exact prices above the IEEE-754 integer boundary.';
  large.task.requiredFields = ['owner']; large.task.budget = '9007199254740993';
  large.offers = large.offers.map((o, i) => ({ ...o, id: ['rhea', 'iris', 'janus'][i],
    price: ['9007199254740992', '9007199254740993', '9007199254740994'][i] }));
  large.results = large.offers.map(o => ({ ...structuredClone(large.reference), serviceId: o.id, serviceVersion: o.version }));
  large.results[0].fields.owner = 'synthetic-wrong-owner';
  large.records = [failure(large, 'rhea', 'mismatch:owner')];

  const future = structuredClone(evaluationCorpus()[7]);
  future.id = future.task.id = 'prospective-future-correction';
  future.purpose = 'A future correction cannot remove the old visible failure before cutoff.';
  future.records[1].recordedAt = future.records[1].observedAt = '2026-10-24T12:06:00.000Z';
  future.results[0].asOf = '2026-10-24T12:03:00.000Z';

  const recovered = structuredClone(evaluationCorpus()[7]);
  recovered.id = recovered.task.id = 'prospective-correction-budget-boundary';
  recovered.purpose = 'A visible correction and a single affordable offer must not cause a stale blacklist or needless abstention.';
  recovered.task.budget = '1';
  return [mixed, large, future, recovered];
}

export async function buildEvaluationPlan() {
  const cases = [...evaluationCorpus(), ...prospectiveCases()];
  const controls = [], conditions = [];
  for (const c of cases) for (const enabled of [false, true]) {
    const row = await evaluateArm(c, deterministicModel, new FrozenMemory(c.records), enabled);
    assert(row.context && row.verdict !== 'error', 'BENCHMARK_CONTROL_INVALID');
    const request = { modelId: MODEL_70B_ID, body: modelRequestV2(row.context) };
    controls.push({ selector: 'deterministic', ...row });
    conditions.push({ caseId: c.id, memoryEnabled: enabled,
      cohort: c.id.startsWith('prospective-') ? 'prospective' : 'development', context: row.context, request, key: hash(request) });
  }
  for (const c of cases) {
    const [off, on] = conditions.filter(p => p.caseId === c.id);
    assert(canonical({ ...off.context, memories: [] }) === canonical({ ...on.context, memories: [] }), 'BENCHMARK_PAIR_MISMATCH');
  }
  const requestKeys = [...new Set(conditions.map(c => c.key))].sort();
  assert(cases.length === 16 && conditions.length === 32 && requestKeys.length <= 32, 'BENCHMARK_PLAN_INVALID');
  return { protocol: 'synthetic-comparison-v1', citationContract: CITATION_CONTRACT,
    mode: 'SYNTHETIC_RECORDED_INPUTS', modelId: MODEL_70B_ID, promptHash: hash(PROMPT_V2), outputProtocol: 'single-json-fence-v1',
    developmentCases: 12, prospectiveCases: 4, logicalModelArms: 32, callLimit: requestKeys.length,
    maxOutputTokens: 512, inputMessagesMaxBytes: 3500, temperature: 0, requestKeys, cases, controls, conditions,
    acceptance: { reportEveryCase: true, noSuccessDependentRetries: true,
      separatelyReport: ['verifier', 'abstention', 'demoCredits', 'declaredReferences', 'citationSupport', 'cohort'],
      claims: 'Verifier improvement and supported citations are separate; no global success inferred from one pair.' },
    limitations: ['All source data and experiences are synthetic; this is not a fresh Walrus/Tatum integration run.',
      'Development cases informed earlier work; prospective cases were designed with knowledge of past outcomes, not independently blinded.',
      'V1 experiences omit numeric freshness conditions; unsupported transfer is unassessable, not inferred.'] };
}
