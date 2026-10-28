import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Journal } from '../src/local-journal.ts';
import { connectModel, MODEL_ID } from '../src/providers/model.ts';
import { connectWalrus } from '../src/providers/walrus.ts';
import { completeMemory } from '../src/memory.ts';
import { assert, canonical, Fault, integer, time } from '../src/domain.ts';
import { deterministicModel, evaluateArm, FrozenMemory, hash } from '../src/evaluation.ts';
import type { EvaluationCase } from '../src/evaluation.ts';
import type { Experience, ModelPort, Snapshot } from '../src/domain.ts';

// One explicitly authorized pair. Never calls Tatum or a memory write method.
const directory = '.local/evaluation/pilot-v1';
let journal: Journal | undefined;
let modelCallsThisInvocation = 0;
const rows: any[] = [];
try {
  assert(process.env.RECALL_EVAL_PILOT_CONFIRMED === 'true', 'EVALUATION_NOT_CONFIRMED');
  assert(process.env.RECALL_FREE_TIER_CONFIRMED === 'true', 'FREE_TIER_NOT_CONFIRMED');
  const index = process.argv.indexOf('--expect-blob');
  const expectedBlob = index >= 0 ? process.argv[index + 1] : undefined;
  assert(expectedBlob && /^[A-Za-z0-9_-]{40,100}$/.test(expectedBlob), 'EXPECTED_BLOB_REQUIRED');
  assert(existsSync('.local/stage0.sqlite'), 'STAGE0_JOURNAL_REQUIRED');
  journal = new Journal('.local/stage0.sqlite');
  const j = journal;
  const original = j.effect('stage0:tatum:source'), verified = j.effect('stage0:tatum:verify');
  assert(original?.state === 'DONE' && verified?.state === 'DONE', 'VERIFIED_RECORDED_SOURCE_REQUIRED');
  const source: Snapshot = JSON.parse(original.response), reference: Snapshot = JSON.parse(verified.response);
  assert(source.source === 'tatum' && source.network === 'mainnet' && source.target === 'checkpoint:' + source.version, 'RECORDED_SOURCE_INVALID');
  integer(source.version); time(source.asOf);
  assert(source.fields.sequenceNumber === source.version && typeof source.fields.digest === 'string'
    && source.fields.digest.length > 0 && canonical(source) === canonical(reference), 'RECORDED_REFERENCE_MISMATCH');
  const receipt = j.outbox('stage0:experience:1');
  assert(receipt?.state === 'DONE' && receipt.blob_id === expectedBlob, 'EXPECTED_RECEIPT_MISMATCH');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const freezePath = directory + '/freeze.json', startedPath = directory + '/memory-read.started';
  let freeze: { capturedAt: string; expectedBlob: string; sourceHash: string; records: Experience[] };
  const memoryReadThisInvocation = !existsSync(freezePath);
  if (memoryReadThisInvocation) {
    // A missing response after this reservation stops, rather than rereading on a rerun.
    assert(!existsSync(startedPath), 'MEMORY_READ_OUTCOME_UNCERTAIN');
    writeFileSync(startedPath, new Date().toISOString(), { flag: 'wx', mode: 0o600 });
    const memory = await connectWalrus(process.env);
    const records = await completeMemory(memory, [expectedBlob]);
    assert(records.length === 1 && canonical(records[0]) === receipt.payload, 'MEMORY_CORPUS_CHANGED');
    freeze = { capturedAt: new Date().toISOString(), expectedBlob, sourceHash: hash(source), records };
    writeFileSync(freezePath, canonical(freeze), { flag: 'wx', mode: 0o600 });
  } else {
    assert(statSync(freezePath).size <= 32768, 'FROZEN_INPUT_TOO_LARGE');
    freeze = JSON.parse(readFileSync(freezePath, 'utf8'));
  }
  assert(freeze.expectedBlob === expectedBlob && freeze.sourceHash === hash(source)
    && freeze.records.length === 1 && canonical(freeze.records[0]) === receipt.payload, 'FROZEN_INPUT_MISMATCH');
  const record = freeze.records[0];
  assert(record.id === 'experience:stage0-smoke' && record.network === 'mainnet' && record.family === 'checkpoint'
    && record.serviceId === 'atlas' && record.serviceVersion === 'v1' && record.verdict === 'fail'
    && record.reasons.includes('missing:digest') && record.evidence.source === 'tatum'
    && record.evidence.version === source.version, 'EXPECTED_EXPERIENCE_MISMATCH');
  const cutoff = new Date(time(record.recordedAt) + 1000).toISOString();
  const age = time(cutoff) - time(source.asOf);
  assert(age >= 0 && age <= 600000, 'RECORDED_TIME_WINDOW_INVALID');
  const offers = ['atlas', 'beacon', 'cipher'].map((id, i) => ({ id, version: 'v1', network: 'mainnet' as const,
    families: ['checkpoint'], fields: ['digest', 'sequenceNumber'], price: String(i + 1) }));
  const c: EvaluationCase = {
    id: 'pilot-checkpoint-1', purpose: 'A single paired test of an existing Walrus failure record.',
    task: { id: 'pilot-checkpoint-1', network: 'mainnet', family: 'checkpoint', target: source.target,
      requiredFields: ['digest', 'sequenceNumber'], maxAgeMs: 600000, budget: '3', cutoff },
    offers, reference, records: freeze.records,
    results: offers.map(offer => {
      const projected = structuredClone(source);
      if (offer.id === 'atlas') delete projected.fields.digest;
      return { ...projected, serviceId: offer.id, serviceVersion: offer.version };
    }),
  };
  const frozenMemory = () => new FrozenMemory(c.records, 'live', [expectedBlob]);
  for (const enabled of [false, true]) rows.push({ selector: 'deterministic',
    ...await evaluateArm(c, deterministicModel, frozenMemory(), enabled) });
  const model = connectModel(process.env);
  for (const enabled of [false, true]) {
    const effectId = 'eval:pilot:v1:model:' + (enabled ? 'on' : 'off');
    const port: ModelPort = { mode: 'live', select: context => j.once(effectId, 'model',
      { modelId: MODEL_ID, caseHash: hash(c), context }, () => {
        modelCallsThisInvocation++;
        assert(modelCallsThisInvocation <= 2, 'PILOT_CALL_LIMIT');
        return model.select(context);
      }) };
    rows.push({ selector: 'model', ...await evaluateArm(c, port, frozenMemory(), enabled) });
    assert(j.effect(effectId)?.state === 'DONE', 'MODEL_OUTCOME_UNCERTAIN');
  }
  const modelOff = rows.find(r => r.selector === 'model' && !r.memoryEnabled);
  const modelOn = rows.find(r => r.selector === 'model' && r.memoryEnabled);
  assert(hash({ ...modelOff.context, memories: [] }) === hash({ ...modelOn.context, memories: [] }), 'PAIR_INPUT_MISMATCH');
  assert(modelOff.context.memories.length === 0 && modelOn.memoryIdsAvailable.includes(record.id), 'PAIR_MEMORY_INVALID');
  const report = {
    status: 'PILOT_COMPLETED', mode: 'LIVE_MODEL_RECORDED_TATUM_FROZEN_WALRUS',
    modelId: MODEL_ID, maxOutputTokensPerCall: 512, caseHash: hash(c), sourceHash: hash(source),
    recordedCheckpoint: source.target, recordedChainTime: source.asOf, frozenAssessmentTime: cutoff,
    memoryCapturedAt: freeze.capturedAt, memoryBlobIds: [expectedBlob], memoryReadThisInvocation,
    modelCallsThisInvocation, tatumCalls: 0, memoryWrites: 0, rows,
    result: { modelOff: modelOff.verdict, modelOn: modelOn.verdict,
      improvedValidResult: modelOff.verdict !== 'pass' && modelOn.verdict === 'pass',
      citedExpectedMemory: modelOn.decision?.memoryIds.includes(record.id) ?? false },
    limitations: ['One pair is descriptive, not a general quality estimate.',
      'Chain data is a recorded verified checkpoint; no new Tatum read occurred.',
      'Memory was read once and frozen; evaluation arms did not write or reread it.',
      'Deterministic controls receive the same experience; no LLM superiority is assumed.'],
  };
  const reportPath = directory + '/report.json';
  if (existsSync(reportPath)) assert(hash(JSON.parse(readFileSync(reportPath, 'utf8')).rows) === hash(rows), 'EXISTING_REPORT_MISMATCH');
  else writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'PILOT_BLOCKED', code: error instanceof Fault ? error.code : 'EVALUATION_FAILED',
    modelCallsThisInvocation, rows, additionalSpendLimitUSD: 0 }));
  process.exitCode = 2;
} finally { journal?.close(); }
