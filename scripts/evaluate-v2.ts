import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Journal } from '../src/local-journal.ts';
import { assert, canonical, Fault, integer, time } from '../src/domain.ts';
import type { ModelPort, Snapshot } from '../src/domain.ts';
import { connectModel, MODEL_ID, modelRequest } from '../src/providers/model.ts';
import { evaluateArm, FrozenMemory, hash } from '../src/evaluation.ts';
import { modelRequestV2, prepareV2, PROMPT_V2, v2Cases, v2RequestIdentity } from '../src/evaluation-v2.ts';

// No Tatum/Walrus imports or network operations: only previously recorded inputs.
const directory = '.local/evaluation/pilot-v2';
const prefix = 'eval:pilot:v2:model:';
let journal: Journal | undefined;
let modelCallsThisInvocation = 0;
const rows: any[] = [];
const usedRequests = new Set<string>();
function readSaved(file: string) {
  assert(existsSync(file) && statSync(file).size <= 131072, 'SAVED_INPUT_MISSING_OR_LARGE');
  return JSON.parse(readFileSync(file, 'utf8'));
}
try {
  assert(process.env.RECALL_EVAL_V2_CONFIRMED === 'true', 'V2_NOT_CONFIRMED');
  assert(process.env.RECALL_FREE_TIER_CONFIRMED === 'true', 'FREE_TIER_NOT_CONFIRMED');
  assert(existsSync('.local/stage0.sqlite'), 'STAGE0_JOURNAL_REQUIRED');
  const freezePath = '.local/evaluation/pilot-v1/freeze.json';
  const predecessorPath = '.local/evaluation/pilot-v1/report.json';
  const freeze = readSaved(freezePath), predecessor = readSaved(predecessorPath);
  const preserved = { freezeHash: hash(freeze), predecessorHash: hash(predecessor) };
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
  const prepared = await prepareV2(cases, freeze.expectedBlob);
  assert(hash(cases[0]) === predecessor.caseHash, 'V1_CASE_CHANGED');
  for (const condition of prepared.plan.filter(p => p.caseId === cases[0].id)) {
    const old = predecessor.rows.find((r: any) => r.selector === 'model' && r.memoryEnabled === condition.memoryEnabled);
    assert(old && modelRequest(old.context).messages[1].content === modelRequestV2(condition.context).messages[1].content,
      'V1_USER_INPUT_CHANGED');
  }
  const plan = { ...preserved, modelId: MODEL_ID, promptHash: hash(PROMPT_V2),
    casesHash: hash(cases), requestKeys: prepared.uniqueKeys,
    conditions: prepared.plan.map(p => ({ caseId: p.caseId, memoryEnabled: p.memoryEnabled, key: p.key })) };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const planPath = directory + '/plan.json';
  if (existsSync(planPath)) assert(hash(readSaved(planPath)) === hash(plan), 'V2_PLAN_CHANGED');
  else writeFileSync(planPath, canonical(plan), { flag: 'wx', mode: 0o600 });
  const oldEffects = j.db.prepare("SELECT id,state FROM effects WHERE id LIKE ?").all(prefix + '%') as any[];
  assert(oldEffects.length <= 5 && oldEffects.every(e => e.state === 'DONE'
    && prepared.uniqueKeys.some(key => e.id === prefix + key)), 'V2_EXISTING_EFFECTS_UNCERTAIN');
  rows.push(...prepared.controls);
  const model = connectModel(process.env, fetch, modelRequestV2);
  for (const condition of prepared.plan) {
    const c = cases.find(c => c.id === condition.caseId)!;
    const reusedWithinReport = usedRequests.has(condition.key);
    const port: ModelPort = { mode: 'live', select: context => {
      const identity = v2RequestIdentity(context);
      assert(identity.key === condition.key, 'V2_REQUEST_PLAN_MISMATCH');
      return j.once(prefix + identity.key, 'model', identity.request, () => {
        assert(modelCallsThisInvocation < 5, 'V2_CALL_LIMIT');
        modelCallsThisInvocation++;
        return model.select(context);
      });
    } };
    const row = await evaluateArm(c, port, new FrozenMemory(c.records, 'live', [freeze.expectedBlob]), condition.memoryEnabled);
    rows.push({ selector: 'model-v2', requestKey: condition.key, reusedIdenticalRequest: reusedWithinReport, ...row });
    usedRequests.add(condition.key);
    assert(j.effect(prefix + condition.key)?.state === 'DONE', 'V2_MODEL_OUTCOME_UNCERTAIN');
  }
  assert(hash(readSaved(freezePath)) === preserved.freezeHash && hash(readSaved(predecessorPath)) === preserved.predecessorHash,
    'PREDECESSOR_CHANGED');
  const modelRows = rows.filter(r => r.selector === 'model-v2');
  const enabled = (id: string) => modelRows.find(r => r.caseId === id && r.memoryEnabled)!;
  const known = enabled(cases[0].id), changed = enabled(cases[1].id), repaired = enabled(cases[2].id);
  const checks = {
    relevantFailureAvoided: known.verdict === 'pass' && known.selectedServiceId !== 'atlas'
      && !!known.decision?.memoryIds.includes(record.id),
    irrelevantFieldDoesNotCauseOverpayment: changed.verdict === 'pass' && changed.selectedServiceId === 'atlas',
    repairedVersionAllowed: repaired.verdict === 'pass' && repaired.selectedServiceId === 'atlas'
      && repaired.memoryIdsAvailable.length === 0,
  };
  const report = { status: 'V2_COMPLETED', mode: 'LIVE_MODEL_RECORDED_INPUTS',
    defaultPrompt: 'v1-unchanged', candidatePrompt: 'v2-evaluator-only', ...plan,
    modelCallsThisInvocation, uniqueModelRequests: prepared.uniqueKeys.length,
    logicalModelArms: modelRows.length, tatumCalls: 0, walrusReads: 0, memoryWrites: 0,
    recordedCheckpoint: source.target, memoryCapturedAt: freeze.capturedAt,
    checks, allChecksPassed: Object.values(checks).every(Boolean), rows,
    limitations: ['The original case is a development case after observing v1 failure.',
      'Five unique requests serve six logical arms; one repaired-version response is shared, not replicated.',
      'Data and memory are recorded; this run makes no new Tatum/Walrus calls.',
      'This is not the full twelve-pair/held-out evaluation or proof of LLM superiority.'] };
  const output = directory + '/report.json';
  if (existsSync(output)) assert(hash(readSaved(output).rows) === hash(rows), 'EXISTING_V2_REPORT_CHANGED');
  else writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'V2_BLOCKED', code: error instanceof Fault ? error.code : 'V2_FAILED',
    modelCallsThisInvocation, rows, additionalSpendLimitUSD: 0 }));
  process.exitCode = 2;
} finally { journal?.close(); }
