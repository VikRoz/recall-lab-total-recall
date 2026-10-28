import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical } from '../src/domain.ts';
import { hash } from '../src/evaluation.ts';
import { MODEL_ID, modelRequest } from '../src/providers/model.ts';
import { buildMemoryScenario, prepareStage, finishScenario, gradeScenarioProposal } from '../src/memory-scenario.ts';
import { restoreScenarioContext, validateSnapshot } from '../src/memory-scenario-context.ts';
import { prepareMemoryScenario, scenarioRunbook } from '../scripts/prepare-memory-scenario.ts';
const original = fileURLToPath(new URL('../evidence/rehearsal-v1/input.json', import.meta.url));
const coverage = fileURLToPath(new URL('../evidence/coverage-mainnet-v1/live-evidence.json', import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const build = () => buildMemoryScenario(load(original), load(coverage));

test('one known scenario uses the verified historical failure and correction without altering its inputs', () => {
  const a = load(original), b = load(coverage), before = canonical([a, b]), s = buildMemoryScenario(a, b);
  assert.equal(canonical([a, b]), before);
  assert.equal(s.origin.verification.status, 'fail'); assert.equal(s.origin.receipt.state, 'DONE');
  assert.equal(s.origin.record.id, 'experience:stage0-smoke');
  assert.equal(s.correction.record.supersedes, s.origin.record.id);
  assert.deepEqual(s.stages.map(x => [x.id, x.task.budget]),
    [['repeat-required-field', '2'], ['field-no-longer-required', '1'], ['after-verified-correction', '1']]);
  assert.equal(s.snapshot.hits.length, 10); assert.equal(s.directFacts.length, 2);
});
test('four comparisons preserve NOT_RUN for LLM, prove B=C bytes, and execute only the rule baseline', async () => {
  const { report: r } = await prepareMemoryScenario(original, coverage);
  assert.equal(r.status, 'OFFLINE_FOUR_WAY_SCENARIO_PREPARED');
  assert.equal(r.hypothesisStatus, 'NOT_TESTED_NO_NEW_LLM_RESPONSES');
  assert.equal(r.plan.providerCallsAllowed, 0); assert.equal(r.plan.liveExecutorIncluded, false);
  assert.equal(r.plan.uniquePreparedRequests, 5); assert.equal(r.plan.logicalModelArms, 9);
  for (const s of r.stages) {
    assert.equal(s.contextEquality.directEqualsRestored, true);
    assert.equal(canonical(s.modelArms[1].request), canonical(s.modelArms[2].request));
    assert.equal(s.D.contextHash, s.modelArms[2].contextHash);
    for (const arm of s.modelArms) {
      assert.equal(arm.status, 'NOT_RUN_NO_MODEL_CALL'); assert.equal(arm.decision, null); assert.equal(arm.rawResponse, null);
    }
  }
  assert.deepEqual(r.stages.map(s => [s.D.proposal.serviceId, s.D.rawVerifier?.status]),
    [['beacon', 'pass'], ['atlas', 'pass'], ['atlas', 'pass']]);
  assert.equal(r.stages[1].contextEquality.allModelInputsEqual, true);
  assert.equal(new Set(r.stages.map(s => s.restoration.processId)).size, 3);
  assert.equal(r.stages.every(s => s.restoration.processId !== process.pid && s.restoration.emptyWorkingDirectory), true);
});
test('restoration selects old failure, no irrelevant failure, then active correction from the full saved namespace', async () => {
  const s = build(), provided = [];
  for (const stage of s.stages) {
    const prepared = prepareStage(stage, s.directFacts, s.snapshot);
    const restored = await restoreScenarioContext(prepared.request, s.snapshot);
    assert.equal(restored.restoredRecords, 10); assert.equal(restored.contextHash, prepared.B.contextHash);
    provided.push(restored.context.memories.map((x: any) => x.id));
  }
  assert.deepEqual(provided, [['experience:stage0-smoke'], [], ['experience:atlas-v1-correction-1']]);
});
test('lost or forged saved bytes, wrong expected hashes and altered fresh-client output block without direct-fact fallback', async () => {
  const s = build(), input = prepareStage(s.stages[0], s.directFacts, s.snapshot).request;
  const missing = structuredClone(s.snapshot); missing.hits.pop();
  assert.throws(() => validateSnapshot(missing), /SNAPSHOT_INVALID/);
  const forged = structuredClone(s.snapshot); forged.hits[0].text = '{}';
  assert.throws(() => validateSnapshot(forged));
  await assert.rejects(restoreScenarioContext({ ...input, snapshotHash: '0'.repeat(64) }, s.snapshot), /INPUT_CHANGED/);
  const wrong = structuredClone(input); wrong.expected[0].hash = '0'.repeat(64);
  await assert.rejects(restoreScenarioContext(wrong, s.snapshot), /INPUT_CHANGED/);
  const restored = [];
  for (const stage of s.stages) restored.push(await restoreScenarioContext(prepareStage(stage, s.directFacts, s.snapshot).request, s.snapshot));
  restored[0].context.memories = [];
  assert.throws(() => finishScenario(s, restored), /DIRECT_RESTORE_MISMATCH/);
});
test('prepared model payloads use the unchanged default, contain no oracle, and obey current request caps', async () => {
  const { report: r, scenario: s } = await prepareMemoryScenario(original, coverage);
  assert.equal(r.plan.modelId, MODEL_ID); assert.equal(r.plan.promptProfile, 'CURRENT_DEFAULT_V1_UNCHANGED');
  const hiddenDigests = s.stages.map(x => x.source.fields.digest);
  for (const prepared of r.plan.requests) {
    const body = prepared.request.body, context = JSON.parse(body.messages[1].content);
    assert.deepEqual(Object.keys(context).sort(), ['memories', 'offers', 'task']);
    assert.equal(canonical(body), canonical(modelRequest(context)));
    assert.equal(Buffer.byteLength(JSON.stringify(body.messages)) <= 3500, true);
    assert.equal(body.max_tokens, 512); assert.equal(body.temperature, 0);
    for (const digest of hiddenDigests) assert.equal(JSON.stringify(body).includes(digest), false);
  }
});
test('scripted bad proposal stays incorrect despite guard, and pass memory never repairs a stale port', async () => {
  const { report: r } = await prepareMemoryScenario(original, coverage);
  const bad = r.stages[0].scriptedControls.find(x => x.proposal.serviceId === 'atlas')!;
  assert.equal(bad.kind, 'SCRIPTED_PROPOSAL_GRADER_CONTROL_NOT_MODEL_OUTPUT');
  assert.equal(bad.rawVerifier?.status, 'fail'); assert.equal(bad.goalCompleted, false);
  assert.equal(bad.controllerOutcome, 'BLOCKED'); assert.equal(bad.localServiceExecutions, 0);
  assert.deepEqual(bad.proposal.memoryIds, []); assert.deepEqual(bad.guardEvidenceIds, ['experience:stage0-smoke']);
  assert.equal(r.stages[2].staleImplementation?.rawVerifier?.status, 'fail');
  assert.equal(r.stages[2].staleImplementation?.goalCompleted, false);
  const stage = build().stages[0], context = prepareStage(stage, build().directFacts, build().snapshot).B.context;
  assert.throws(() => gradeScenarioProposal(stage, context, { serviceId: 'beacon', reason: 'test', memoryIds: ['fake'] }), /UNKNOWN_MEMORY_REFERENCE/);
});
test('fresh clients inherit no credentials and repeated preparations preserve plan/runbook', async () => {
  const keys = ['TATUM_API_KEY', 'MEMWAL_KEY', 'CLOUDFLARE_API_TOKEN', 'MEMWAL_ACCOUNT_ID'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) process.env[k] = 'four-way-parent-secret-sentinel';
    const a = (await prepareMemoryScenario(original, coverage)).report, b = (await prepareMemoryScenario(original, coverage)).report;
    assert.equal(a.planHash, b.planHash); assert.equal(hash(a.plan), a.planHash);
    assert.equal(scenarioRunbook(a), scenarioRunbook(b));
    assert.equal(JSON.stringify(a).includes('four-way-parent-secret-sentinel'), false);
    assert.equal(a.stages.every(s => s.restoration.credentialEnvironment === 'NONE'), true);
    assert.equal(a.measuredThisRun.newLlmResponses, 0);
  } finally { for (const k of keys) saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]; }
});
test('tampered source, symlink input and execute arguments are rejected before any inference', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'four-way-bad-input-'));
  try {
    const changed = load(coverage); changed.outbox.pop();
    writeFileSync(join(dir, 'changed.json'), JSON.stringify(changed));
    await assert.rejects(prepareMemoryScenario(original, join(dir, 'changed.json')), /EVIDENCE_CHANGED/);
    symlinkSync(coverage, join(dir, 'link.json'));
    await assert.rejects(prepareMemoryScenario(original, join(dir, 'link.json')), /FILE_INVALID/);
    const result = spawnSync(process.execPath, ['--experimental-strip-types',
      fileURLToPath(new URL('../scripts/prepare-memory-scenario.ts', import.meta.url)), '--execute'], { encoding: 'utf8' });
    assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).code, 'SCENARIO_ARGUMENTS_INVALID');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
