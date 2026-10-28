import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Journal } from '../src/local-journal.ts';
import { assert, canonical, Fault, integer, time } from '../src/domain.ts';
import type { ModelPort, Snapshot } from '../src/domain.ts';
import { connectModel, MODEL_ID, MODEL_70B_ID, modelRequest } from '../src/providers/model.ts';
import { evaluateArm, FrozenMemory, hash } from '../src/evaluation.ts';
import { modelRequestV2, PROMPT_V2, v2Cases } from '../src/evaluation-v2.ts';

import { prepare70b, request70b, run70bPlan, unwrapEvaluatorJson } from '../src/evaluation-70b.ts';

// No Tatum/Walrus imports or network operations: only previously recorded inputs.
const directory = '.local/evaluation/pilot-70b';
const prefix = 'eval:pilot:70b:model:';
let journal: Journal | undefined;
let modelCallsThisInvocation = 0;
let providerStatus: number | null = null;
const rows: any[] = [];
const usedRequests = new Set<string>();
function readSaved(file: string) {
  assert(existsSync(file) && statSync(file).size <= 131072, 'SAVED_INPUT_MISSING_OR_LARGE');
  return JSON.parse(readFileSync(file, 'utf8'));
}
try {
  assert(process.env.RECALL_EVAL_70B_CONFIRMED === 'true', 'MODEL70B_NOT_CONFIRMED');
  assert(process.env.RECALL_EVAL_70B_ENVELOPE_CONFIRMED === 'true', 'MODEL70B_ENVELOPE_NOT_CONFIRMED');
  assert(process.env.RECALL_FREE_TIER_CONFIRMED === 'true', 'FREE_TIER_NOT_CONFIRMED');
  assert(existsSync('.local/stage0.sqlite'), 'STAGE0_JOURNAL_REQUIRED');
  const freezePath = '.local/evaluation/pilot-v1/freeze.json';
  const predecessorPath = '.local/evaluation/pilot-v1/report.json';
  const v2Path = '.local/evaluation/pilot-v2/report.json';
  const freeze = readSaved(freezePath), predecessor = readSaved(predecessorPath), v2 = readSaved(v2Path);
  assert(v2.status === 'V2_COMPLETED' && v2.allChecksPassed === false, 'V2_REPORT_INVALID');
  const preserved = { freezeHash: hash(freeze), predecessorHash: hash(predecessor), v2Hash: hash(v2),
    priorFileHashes: Object.fromEntries([freezePath, predecessorPath, v2Path, '.local/evaluation/pilot-v2/plan.json'].map(path => [path, hash(readFileSync(path, 'utf8'))])) };
  assert(predecessor.status === 'PILOT_COMPLETED' && predecessor.modelId === MODEL_ID, 'V1_REPORT_INVALID');
  journal = new Journal('.local/stage0.sqlite'); const j = journal;
  const original = j.effect('stage0:tatum:source'), verified = j.effect('stage0:tatum:verify');
  assert(original?.state === 'DONE' && verified?.state === 'DONE', 'RECORDED_SOURCE_REQUIRED');
  const source: Snapshot = JSON.parse(original.response), reference: Snapshot = JSON.parse(verified.response);
  integer(source.version); time(source.asOf);
  assert(source.source === 'tatum' && source.network === 'mainnet' && source.target === 'checkpoint:' + source.version
    && canonical(source) === canonical(reference) && freeze.sourceHash === hash(source), 'RECORDED_SOURCE_MISMATCH');
  const receipt = j.outbox('stage0:experience:1');
  assert(receipt?.state === 'DONE' && receipt.blob_id === freeze.expectedBlob && freeze.records.length === 1
    && canonical(freeze.records[0]) === receipt.payload, 'FROZEN_MEMORY_MISMATCH');
  const record = freeze.records[0];
  assert(record.family === 'checkpoint' && record.serviceId === 'atlas' && record.serviceVersion === 'v1'
    && record.verdict === 'fail' && record.reasons.includes('missing:digest') && record.evidence.version === source.version,
  'EXPERIENCE_MISMATCH');
  const cases = v2Cases(source, reference, freeze.records);
  const prepared = await prepare70b(cases, freeze.expectedBlob);
  assert(hash(cases[0]) === predecessor.caseHash, 'V1_CASE_CHANGED');
  for (const condition of prepared.plan.filter(p => p.caseId === cases[0].id)) {
    const old = predecessor.rows.find((r: any) => r.selector === 'model' && r.memoryEnabled === condition.memoryEnabled);
    assert(old && modelRequest(old.context).messages[1].content === modelRequestV2(condition.context).messages[1].content,
      'V1_USER_INPUT_CHANGED');
  }
  for (const condition of prepared.plan) {
    const prior = v2.rows.find((r: any) => r.selector === 'model-v2' && r.caseId === condition.caseId && r.memoryEnabled === condition.memoryEnabled);
    assert(prior && canonical(modelRequestV2(prior.context)) === canonical(condition.request.body), 'V2_BODY_CHANGED');
  }
  const plan = { ...preserved, modelId: MODEL_70B_ID, promptHash: hash(PROMPT_V2),
    callLimit: 5, gate: 'off-fail_on-pass_cites-relevant-memory_before-controls',
    casesHash: hash(cases), requestKeys: prepared.uniqueKeys,
    conditions: prepared.plan.map(p => ({ caseId: p.caseId, memoryEnabled: p.memoryEnabled, key: p.key })) };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const planPath = directory + '/plan.json';
  if (existsSync(planPath)) assert(hash(readSaved(planPath)) === hash(plan), 'V2_PLAN_CHANGED');
  else writeFileSync(planPath, canonical(plan), { flag: 'wx', mode: 0o600 });
  const oldEffects = j.db.prepare("SELECT id,state FROM effects WHERE id LIKE ?").all(prefix + '%') as any[];
  assert(oldEffects.length <= 5 && oldEffects.every(e => e.state === 'DONE'
    && prepared.uniqueKeys.some(key => e.id === prefix + key)), 'V2_EXISTING_EFFECTS_UNCERTAIN');
  const blockedPath = '.local/evaluation/pilot-70b.stdout.json';
  const blocked = readSaved(blockedPath);
  assert(blocked.status === 'MODEL70B_BLOCKED' && blocked.code === 'MODEL70B_RESPONSE_UNUSABLE'
    && blocked.modelCallsThisInvocation === 1, 'ORIGINAL_BLOCKED_RUN_REQUIRED');
  assert(j.effect(prefix + prepared.plan[0].key)?.state === 'DONE', 'ORIGINAL_OFF_RESPONSE_REQUIRED');
  const envelopePlan = { originalPlanHash: hash(plan), blockedFileHash: hash(readFileSync(blockedPath, 'utf8')),
    outputProtocol: 'single-json-fence-v1', callLimitTotal: 5 };
  const envelopePath = directory + '/envelope-plan.json';
  if (existsSync(envelopePath)) assert(hash(readSaved(envelopePath)) === hash(envelopePlan), 'ENVELOPE_PLAN_CHANGED');
  else writeFileSync(envelopePath, canonical(envelopePlan), { flag: 'wx', mode: 0o600 });
  rows.push(...prepared.controls);
  const model = connectModel(process.env, async (url, options) => {
    const response = await fetch(url, options); providerStatus = response.status; return response;
  }, modelRequestV2, MODEL_70B_ID);
  const run = await run70bPlan(prepared, record.id, async condition => {
    const c = cases.find(c => c.id === condition.caseId)!;
    const reusedWithinReport = usedRequests.has(condition.key);
    const cachedAtStart = j.effect(prefix + condition.key)?.state === 'DONE';
    let outputEnvelopeRemoved = false;
    let rawResponseHash: string | null = null;
    const port: ModelPort = { mode: 'live', select: async context => {
      const identity = request70b(context);
      assert(identity.key === condition.key, 'MODEL70B_REQUEST_PLAN_MISMATCH');
      const raw = await j.once(prefix + identity.key, 'model', identity.request, () => {
        assert(modelCallsThisInvocation < 5 - oldEffects.length, 'MODEL70B_CALL_LIMIT');
        modelCallsThisInvocation++;
        return model.select(context);
      });
      rawResponseHash = hash(raw);
      const parsed = unwrapEvaluatorJson(raw); outputEnvelopeRemoved = parsed.envelopeRemoved;
      return parsed.value;
    } };
    const row = await evaluateArm(c, port, new FrozenMemory(c.records, 'live', [freeze.expectedBlob]), condition.memoryEnabled);
    const saved = { selector: 'model-70b', requestKey: condition.key, reusedIdenticalRequest: reusedWithinReport, cachedAtStart, outputEnvelopeRemoved, rawResponseHash, ...row };
    rows.push(saved); usedRequests.add(condition.key);
    assert(j.effect(prefix + condition.key)?.state === 'DONE', 'MODEL70B_MODEL_OUTCOME_UNCERTAIN');
    assert(row.verdict !== 'error', 'MODEL70B_RESPONSE_UNUSABLE');
    return saved;
  });
  assert(hash(readSaved(freezePath)) === preserved.freezeHash && hash(readSaved(predecessorPath)) === preserved.predecessorHash,
    'PREDECESSOR_CHANGED');
  assert(Object.entries(preserved.priorFileHashes).every(([path, digest]) => hash(readFileSync(path, 'utf8')) === digest), 'PRIOR_FILE_CHANGED');
  assert(hash(readFileSync(blockedPath, 'utf8')) === envelopePlan.blockedFileHash, 'BLOCKED_RUN_CHANGED');
  const totalEffects = j.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE id LIKE ?").get(prefix + '%') as any;
  assert(totalEffects.n <= 5, 'MODEL70B_TOTAL_LIMIT');
  const modelRows = rows.filter(r => r.selector === 'model-70b');
  const enabled = (id: string) => modelRows.find(r => r.caseId === id && r.memoryEnabled)!;
  const known = enabled(cases[0].id), changed = enabled(cases[1].id), repaired = enabled(cases[2].id);
  const checks = {
    relevantFailureAvoided: run.pairImproved,
    irrelevantFieldDoesNotCauseOverpayment: changed ? changed.verdict === 'pass' && changed.selectedServiceId === 'atlas' : null,
    repairedVersionAllowed: repaired ? repaired.verdict === 'pass' && repaired.selectedServiceId === 'atlas' && repaired.memoryIdsAvailable.length === 0 : null,
  };
  const report = { status: run.pairImproved ? 'MODEL70B_CONTROLS_COMPLETED' : 'MODEL70B_STOPPED_NO_IMPROVEMENT', mode: 'LIVE_MODEL_RECORDED_INPUTS',
    ...envelopePlan, totalModelCallsExperiment: totalEffects.n,
    defaultPrompt: 'v1-unchanged', candidatePrompt: 'v2-unchanged-evaluator-only', defaultModelUnchanged: true, ...plan,
    modelCallsThisInvocation, providerStatus, usedUniqueRequests: usedRequests.size, uniqueModelRequests: prepared.uniqueKeys.length,
    logicalModelArms: modelRows.length, tatumCalls: 0, walrusReads: 0, memoryWrites: 0,
    recordedCheckpoint: source.target, memoryCapturedAt: freeze.capturedAt,
    checks, allChecksPassed: Object.values(checks).every(v => v === true), rows,
    limitations: ['The original case is a development case after observing v1 failure.',
      'Controls run only after a failing off arm and passing on arm that cites relevant memory; a repaired response is shared.',
      'Data and memory are recorded; this run makes no new Tatum/Walrus calls.',
      'This is not the full twelve-pair/held-out evaluation or proof of LLM superiority.'] };
  const output = directory + '/report.json';
  if (existsSync(output)) assert(hash(readSaved(output).rows) === hash(rows), 'EXISTING_V2_REPORT_CHANGED');
  else writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'MODEL70B_BLOCKED', code: error instanceof Fault ? error.code : 'V2_FAILED',
    modelCallsThisInvocation, providerStatus, rows, additionalSpendLimitUSD: 0 }));
  process.exitCode = 2;
} finally { journal?.close(); }
