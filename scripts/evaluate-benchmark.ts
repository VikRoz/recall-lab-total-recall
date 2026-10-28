import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { assert, Fault } from '../src/domain.ts';
import type { ModelPort } from '../src/domain.ts';
import { Journal } from '../src/local-journal.ts';
import { assessCitations } from '../src/citations.ts';
import { evaluateArm, FrozenMemory, hash, summarize } from '../src/evaluation.ts';
import { buildEvaluationPlan } from '../src/evaluation-plan.ts';
import { modelRequestV2 } from '../src/evaluation-v2.ts';
import { unwrapEvaluatorJson } from '../src/evaluation-70b.ts';
import { connectModel, MODEL_70B_ID } from '../src/providers/model.ts';

const directory = '.local/evaluation/benchmark-v1', prefix = 'eval:benchmark:v1:model:';
let journal: Journal | undefined, modelCallsThisInvocation = 0, providerStatus: number | null = null;
const rows: any[] = [];
try {
  assert(process.env.RECALL_EVAL_BENCHMARK_CONFIRMED === 'true', 'BENCHMARK_NOT_CONFIRMED');
  assert(process.env.RECALL_FREE_TIER_CONFIRMED === 'true', 'FREE_TIER_NOT_CONFIRMED');
  const path = directory + '/plan.json';
  assert(existsSync(path) && statSync(path).size <= 524288 && existsSync('.local/stage0.sqlite'), 'BENCHMARK_INPUT_MISSING_OR_LARGE');
  const savedPlan = JSON.parse(readFileSync(path, 'utf8')), planHash = hash(savedPlan);
  // Rebuild in-memory contexts to retain the original JSON wire property order.
  // Canonical persistence sorts object keys; its hash still binds every value and request string.
  const plan = await buildEvaluationPlan();
  assert(process.env.RECALL_BENCHMARK_PLAN_HASH === planHash, 'BENCHMARK_PLAN_NOT_APPROVED');
  assert(hash(plan) === planHash, 'BENCHMARK_PLAN_CHANGED');
  assert(!existsSync(directory + '/report.json'), 'BENCHMARK_ALREADY_COMPLETE_READ_REPORT');
  const preserved = Object.fromEntries(['pilot-v1/freeze.json', 'pilot-v1/report.json', 'pilot-v2/report.json',
    'pilot-70b/report.json', 'pilot-70b.stdout.json', 'pilot-70b-envelope.stdout.json'].map(name => {
    const path = '.local/evaluation/' + name; return [path, hash(readFileSync(path, 'utf8'))];
  }));
  journal = new Journal('.local/stage0.sqlite'); const j = journal;
  const before = j.db.prepare('SELECT id,state FROM effects WHERE id LIKE ?').all(prefix + '%') as any[];
  assert(before.length <= plan.callLimit && before.every(e => e.state === 'DONE' && plan.requestKeys.some(k => e.id === prefix + k)),
    'BENCHMARK_UNCERTAIN_EFFECT');
  const model = connectModel(process.env, async (url, options) => {
    const response = await fetch(url, options); providerStatus = response.status; return response;
  }, modelRequestV2, MODEL_70B_ID);
  const used = new Set<string>();
  for (const condition of plan.conditions) {
    const input = plan.cases.find(c => c.id === condition.caseId)!;
    const cachedAtStart = j.effect(prefix + condition.key)?.state === 'DONE';
    let rawResponseHash: string | null = null, outputEnvelopeRemoved = false;
    const port: ModelPort = { mode: 'live', select: async context => {
      const request = { modelId: MODEL_70B_ID, body: modelRequestV2(context) };
      assert(hash(request) === condition.key, 'BENCHMARK_REQUEST_CHANGED');
      const raw = await j.once(prefix + condition.key, 'model', request, async () => {
        assert(modelCallsThisInvocation < plan.callLimit - before.length, 'BENCHMARK_CALL_LIMIT');
        modelCallsThisInvocation++; return model.select(context);
      });
      rawResponseHash = hash(raw);
      const parsed = unwrapEvaluatorJson(raw); outputEnvelopeRemoved = parsed.envelopeRemoved; return parsed.value;
    } };
    const row = await evaluateArm(input, port, new FrozenMemory(input.records), condition.memoryEnabled);
    rows.push({ selector: 'model-70b-v2', cohort: condition.cohort, requestKey: condition.key, cachedAtStart,
      reusedIdenticalRequest: used.has(condition.key), rawResponseHash, outputEnvelopeRemoved, ...row,
      citationAudit: row.context && row.decision ? assessCitations(row.context, row.decision) : null });
    used.add(condition.key);
    // A malformed response is a scored error; an uncertain provider effect stops without retries.
    assert(j.effect(prefix + condition.key)?.state === 'DONE', 'BENCHMARK_PROVIDER_OUTCOME_UNCERTAIN');
    const progressPath = directory + '/progress.json';
    writeFileSync(progressPath, JSON.stringify({ planHash, modelCallsThisInvocation, rows }, null, 2), { mode: 0o600 });
  }
  assert(Object.entries(preserved).every(([path, digest]) => hash(readFileSync(path, 'utf8')) === digest), 'BENCHMARK_PRIOR_ARTIFACT_CHANGED');
  const total = (j.db.prepare('SELECT COUNT(*) AS n FROM effects WHERE id LIKE ?').get(prefix + '%') as any).n;
  assert(total <= plan.callLimit, 'BENCHMARK_TOTAL_LIMIT');
  const report = { status: 'BENCHMARK_COMPLETED', mode: 'LIVE_MODEL_SYNTHETIC_INPUTS', planHash,
    modelId: plan.modelId, promptHash: plan.promptHash, citationContract: plan.citationContract,
    modelCallsThisInvocation, totalModelCallsExperiment: total, logicalModelArms: rows.length,
    providerStatus, tatumCalls: 0, walrusOperations: 0, defaultModelUnchanged: true,
    summaries: Object.fromEntries(['development', 'prospective'].flatMap(cohort => [false, true].map(enabled => [
      cohort + ':' + (enabled ? 'on' : 'off'), summarize(rows.filter(r => r.cohort === cohort && r.memoryEnabled === enabled)),
    ]))), rows, controls: plan.controls, limitations: plan.limitations };
  const output = directory + '/report.json';
  if (existsSync(output)) assert(hash(JSON.parse(readFileSync(output, 'utf8')).rows) === hash(rows), 'BENCHMARK_REPORT_EXISTS');
  else writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'BENCHMARK_BLOCKED', code: error instanceof Fault ? error.code : 'BENCHMARK_FAILED',
    modelCallsThisInvocation, providerStatus, rows, additionalSpendLimitUSD: 0 }));
  process.exitCode = 2;
} finally { journal?.close(); }
