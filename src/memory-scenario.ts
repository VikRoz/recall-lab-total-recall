// One development scenario, not a new holdout or an inference runner.
import { assert, canonical, decision, time, verify } from './domain.ts';
import type { Context, Decision, Offer, Result, Snapshot, Task } from './domain.ts';
import { deterministicSelect } from './agent.ts';
import { hash } from './evaluation.ts';
import { knownFieldFailureIds } from './projection-policy.ts';
import { MODEL_ID, modelRequest } from './providers/model.ts';
import { initialContext, recordedProjection, validateRehearsalEvidence, REHEARSAL_INPUT_HASH } from './rehearsal.ts';
import { validateCoverageRehearsal, COVERAGE_REHEARSAL_HASH } from './rehearsal-coverage.ts';
import { scenarioContext } from './memory-scenario-context.ts';
import type { SavedSnapshot, RestoreRequest } from './memory-scenario-context.ts';

export type ScenarioStage = { id: string; label: string; task: Task; offers: Offer[];
  source: Snapshot; reference: Snapshot; repaired: boolean; oracle: Result[] };
export function buildMemoryScenario(originalRaw: unknown, coverageRaw: unknown) {
  const original = validateRehearsalEvidence(originalRaw), coverage = validateCoverageRehearsal(coverageRaw);
  const first = initialContext(original), source: Snapshot = JSON.parse(original.stage0.effects['stage0:tatum:source'].response);
  const selected = decision(JSON.parse(original.stage0.effects['stage0:model:select'].response), first);
  assert(selected.serviceId === 'atlas', 'SCENARIO_ORIGIN_CHANGED');
  const offer = first.offers.find(x => x.id === selected.serviceId)!;
  const initialFailure = verify(first.task, offer, recordedProjection(source, offer, false), source);
  assert(initialFailure.status === 'fail' && canonical(initialFailure.reasons) === canonical(original.stage0.record.reasons), 'SCENARIO_ORIGIN_INVALID');
  const snapshotReader = coverage.readers.find((r: any) => r.wave === 'B');
  const snapshot: SavedSnapshot = { schema: 1, mode: 'SAVED_WALRUS_BYTES_LOCAL_RESTORE_NOT_LIVE',
    sourceEvidenceHash: COVERAGE_REHEARSAL_HASH, manifestHash: snapshotReader.hash,
    entries: structuredClone(snapshotReader.manifest.entries), hits: structuredClone(snapshotReader.result.hits) };
  const directFacts = [original.stage0.record, original.correction.probe.record].map(x => JSON.parse(canonical(x)));
  const offers: Offer[] = first.offers.filter(x => ['atlas', 'beacon'].includes(x.id));
  const before = new Date(time(original.stage0.record.recordedAt) + 1000).toISOString();
  const p = original.correction.probe;
  const stages: ScenarioStage[] = [
    { id: 'repeat-required-field', label: 'Новый сеанс: digest по-прежнему нужен',
      task: { ...first.task, id: 'memory-scenario-repeat', maxAgeMs: 60000, budget: '2', cutoff: before },
      offers, source, reference: source, repaired: false, oracle: [] },
    { id: 'field-no-longer-required', label: 'Контроль: нужен только sequenceNumber, бюджет1',
      task: { ...first.task, id: 'memory-scenario-narrow', requiredFields: ['sequenceNumber'], maxAgeMs: 60000, budget: '1', cutoff: before },
      offers, source, reference: source, repaired: false, oracle: [] },
    { id: 'after-verified-correction', label: 'После correction: Atlas исправлен, бюджет1',
      task: { ...p.task, id: 'memory-scenario-corrected', budget: '1', cutoff: p.record.recordedAt },
      offers, source: p.source, reference: p.reference, repaired: true, oracle: [] },
  ].map(s => ({ ...structuredClone(s), oracle: offers.map(o => recordedProjection(s.source, o, s.repaired)) }));
  return { schema: 1, mode: 'OFFLINE_DEVELOPMENT_SCENARIO_NOT_HOLDOUT',
    originalEvidenceHash: REHEARSAL_INPUT_HASH, coverageEvidenceHash: COVERAGE_REHEARSAL_HASH,
    origin: { label: 'HISTORICAL_MODEL_RESPONSE_NOT_A_NEW_COMPARISON',
      originalRequestHash: original.stage0.effects['stage0:model:select'].hash,
      decision: selected, verification: initialFailure, record: original.stage0.record, receipt: original.stage0.receipt },
    correction: { record: p.record, receipt: original.correction['writer-result'].receipt },
    snapshot, directFacts, stages };
}
export function gradeScenarioProposal(stage: ScenarioStage, context: Context, raw: unknown) {
  const proposal = decision(raw, context), guard = knownFieldFailureIds(context, proposal);
  if (proposal.serviceId === null) return { proposal, rawVerifier: null, goalCompleted: false,
    controllerOutcome: 'DECLINED', guardEvidenceIds: [], localServiceExecutions: 0, demoCredits: '0' };
  const offer = stage.offers.find(x => x.id === proposal.serviceId)!;
  const result = stage.oracle.find(x => x.serviceId === offer.id)!;
  // Counterfactual grading on saved bytes is not a service call, and never changes admission.
  const rawVerifier = verify(stage.task, offer, result, stage.reference);
  return { proposal, rawVerifier, goalCompleted: rawVerifier.status === 'pass' && guard.length === 0,
    controllerOutcome: guard.length ? 'BLOCKED' : 'LOCAL_PROJECTION_VERIFIED', guardEvidenceIds: guard,
    localServiceExecutions: guard.length ? 0 : 1, demoCredits: guard.length ? '0' : offer.price };
}
export function prepareStage(stage: ScenarioStage, directFacts: any[], snapshot: SavedSnapshot) {
  const A = scenarioContext(stage.task, stage.offers, []), B = scenarioContext(stage.task, stage.offers, directFacts);
  const request: RestoreRequest = { schema: 1, stageId: stage.id, task: stage.task, offers: stage.offers,
    snapshotHash: hash(snapshot), expected: snapshot.entries };
  return { A, B, request };
}
export function preparedModelArm(stageId: string, condition: 'A' | 'B' | 'C', context: Context) {
  const request = { modelId: MODEL_ID, body: modelRequest(context) };
  return { stageId, condition, status: 'NOT_RUN_NO_MODEL_CALL', decision: null, rawResponse: null,
    contextHash: hash(context), requestHash: hash(request), request,
    encodedInputBytes: Buffer.byteLength(JSON.stringify(request.body.messages)), providerCalls: 0 };
}
export function finishScenario(scenario: ReturnType<typeof buildMemoryScenario>, restored: any[]) {
  const stages = [], requests = new Map<string, any>();
  for (const stage of scenario.stages) {
    const prepared = prepareStage(stage, scenario.directFacts, scenario.snapshot);
    const C = restored.find(x => x.stageId === stage.id);
    assert(C?.status === 'OFFLINE_SAVED_MEMORY_RESTORED' && C.requestHash === hash(prepared.request)
      && C.restoredRecords === 10 && C.contextHash === prepared.B.contextHash
      && canonical(C.context) === canonical(prepared.B.context), 'SCENARIO_DIRECT_RESTORE_MISMATCH');
    const modelArms = [preparedModelArm(stage.id, 'A', prepared.A.context),
      preparedModelArm(stage.id, 'B', prepared.B.context), preparedModelArm(stage.id, 'C', C.context)];
    for (const arm of modelArms) {
      const existing = requests.get(arm.requestHash);
      if (existing) existing.logicalArms.push(stage.id + ':' + arm.condition);
      else requests.set(arm.requestHash, { key: arm.requestHash, request: arm.request,
        logicalArms: [stage.id + ':' + arm.condition] });
    }
    assert(modelArms[1].requestHash === modelArms[2].requestHash, 'SCENARIO_REQUEST_BYTES_DIFFER');
    const baseline = gradeScenarioProposal(stage, C.context, deterministicSelect(C.context));
    assert(baseline.goalCompleted, 'SCENARIO_RULE_BASELINE_FAILED');
    const controls = stage.offers.filter(o => BigInt(o.price) <= BigInt(stage.task.budget)).map(o => ({
      kind: 'SCRIPTED_PROPOSAL_GRADER_CONTROL_NOT_MODEL_OUTPUT',
      ...gradeScenarioProposal(stage, C.context, { serviceId: o.id, reason: 'Explicit offline verifier/guard check.', memoryIds: [] }),
    }));
    const staleImplementation = stage.repaired ? {
      kind: 'PASS_MEMORY_DOES_NOT_REPAIR_PORT_NOT_MODEL_OUTPUT',
      ...gradeScenarioProposal({ ...stage, oracle: stage.offers.map(o => recordedProjection(stage.source, o, false)) },
        C.context, { serviceId: 'atlas', reason: 'Explicit stale-code control.', memoryIds: [] }),
    } : null;
    assert(!staleImplementation || staleImplementation.rawVerifier?.status === 'fail'
      && staleImplementation.guardEvidenceIds.length === 0 && !staleImplementation.goalCompleted,
    'SCENARIO_STALE_CODE_CONTROL_FAILED');
    stages.push({ id: stage.id, label: stage.label, task: stage.task, modelArms,
      D: { condition: 'D', status: 'DETERMINISTIC_BASELINE_EXECUTED_OFFLINE', selector: 'EXISTING_FIELD_AWARE_RULES',
        contextHash: C.contextHash, ...baseline, providerCalls: 0 },
      contextEquality: { directEqualsRestored: true, allModelInputsEqual: modelArms.every(a => a.requestHash === modelArms[0].requestHash) },
      directFactsTrace: prepared.B.trace, restoredMemoryTrace: C.trace,
      restoration: { ...C, context: undefined, trace: undefined }, scriptedControls: controls, staleImplementation });
  }
  assert(requests.size === 5 && stages.length === 3 && stages[1].contextEquality.allModelInputsEqual,
    'SCENARIO_COMPARISON_MATRIX_CHANGED');
  const plan = { schema: 1, status: 'OFFLINE_PREPARED_NOT_AUTHORIZED_FOR_INFERENCE',
    hypothesisStatus: 'NOT_TESTED_NO_NEW_LLM_RESPONSES', modelId: MODEL_ID, promptProfile: 'CURRENT_DEFAULT_V1_UNCHANGED',
    originalEvidenceHash: scenario.originalEvidenceHash, coverageEvidenceHash: scenario.coverageEvidenceHash,
    snapshotHash: hash(scenario.snapshot), scenarioHash: hash(scenario),
    stages: stages.map(s => ({ id: s.id, task: s.task, arms: s.modelArms.map(a => ({ condition: a.condition, requestHash: a.requestHash })) })),
    logicalModelArms: 9, uniquePreparedRequests: requests.size, providerCallsAllowed: 0,
    requests: [...requests.values()], additionalSpendLimitUSD: 0, liveExecutorIncluded: false };
  return { status: 'OFFLINE_FOUR_WAY_SCENARIO_PREPARED', hypothesisStatus: plan.hypothesisStatus,
    planHash: hash(plan), plan, origin: scenario.origin, correction: scenario.correction,
    stages, measuredThisRun: { restoredContexts: 3, ruleDecisions: 3, newLlmResponses: 0,
      providerCalls: { tatum: 0, walrus: 0, model: 0 }, newMainnetWrites: 0, additionalSpendUSD: 0 },
    limitations: ['One known development scenario with two boundary controls, not three independent tasks or a new holdout.',
      'A/B/C are prepared inputs with NOT_RUN results; D and scripted checks are local algorithms, not LLM outputs.',
      'C restores previously saved Walrus bytes locally; no new remote recall or persistent write is performed.',
      'Faults are explicitly owned controlled projections, not an external Tatum outage.',
      'B and C have identical model request bytes. Their source cannot by itself establish a model-quality difference.',
      'Five prepared request identities do not authorize five calls or establish a sufficient sample size.'] };
}
