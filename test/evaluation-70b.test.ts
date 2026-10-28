import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/local-journal.ts';
import { prepare70b, request70b, pairImproved, run70bPlan, unwrapEvaluatorJson } from '../src/evaluation-70b.ts';
import { modelRequestV2, v2Cases } from '../src/evaluation-v2.ts';
import { connectModel, MODEL_ID, MODEL_70B_ID, modelRequest } from '../src/providers/model.ts';
import { decision } from '../src/domain.ts';
import { evaluateArm, FrozenMemory } from '../src/evaluation.ts';
import type { Experience, Snapshot } from '../src/domain.ts';

const source: Snapshot = { network: 'mainnet', target: 'checkpoint:42', version: '42',
  asOf: '2026-10-26T12:00:00.000Z', fields: { digest: 'synthetic-digest', sequenceNumber: '42' }, source: 'tatum' };
const record: Experience = { schema: 1, kind: 'experience', id: 'experience:test', network: 'mainnet', family: 'checkpoint',
  serviceId: 'atlas', serviceVersion: 'v1', recordedAt: '2026-10-26T12:00:02.000Z', observedAt: source.asOf,
  verdict: 'fail', reasons: ['missing:digest'], supersedes: null,
  evidence: { source: 'tatum', target: source.target, version: source.version } };
const prepare = () => prepare70b(v2Cases(source, source, [record]), 'synthetic-blob');
const row = (enabled: boolean, verdict: string, ids: string[] = []) => ({ memoryEnabled: enabled, verdict, decision: { memoryIds: ids } });
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'public-test-sentinel' };

test('70B preserves every V2 body and uses a different model in request identities', async () => {
  const p = await prepare();
  assert.equal(p.uniqueKeys.length, 5);
  for (const c of p.plan) {
    assert.deepEqual(c.request.body, modelRequestV2(c.context));
    assert.equal(c.request.modelId, MODEL_70B_ID);
    assert.equal(c.key, request70b(c.context).key);
  }
});
test('lack of paired improvement stops after exactly two arms', async () => {
  for (const [off, on, ids] of [['fail', 'fail', [record.id]], ['pass', 'pass', [record.id]], ['fail', 'pass', []]]) {
    let calls = 0;
    const result = await run70bPlan(await prepare(), record.id, async c => {
      calls++; return row(c.memoryEnabled, c.memoryEnabled ? String(on) : String(off), ids as string[]);
    });
    assert.equal(calls, 2); assert.equal(result.pairImproved, false);
  }
  assert.equal(pairImproved([row(false, 'error'), row(true, 'pass', [record.id])], record.id), false);
});
test('improved pair unlocks controls with five durable requests for six logical arms', async () => {
  const prepared = await prepare(), journal = new Journal(':memory:'); let calls = 0;
  try {
    const result = await run70bPlan(prepared, record.id, c => journal.once('eval:pilot:70b:model:' + c.key, 'model', c.request, async () => {
      calls++; return row(c.memoryEnabled, c.caseId === 'pilot-checkpoint-1' && !c.memoryEnabled ? 'fail' : 'pass', [record.id]);
    }));
    assert.equal(result.pairImproved, true); assert.equal(result.rows.length, 6); assert.equal(calls, 5);
    assert.equal((journal.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as any).n, 0);
  } finally { journal.close(); }
});
test('provider failure leaves UNKNOWN and neither retries nor runs controls', async () => {
  const prepared = await prepare(), journal = new Journal(':memory:'); let calls = 0;
  const invoke = (c: typeof prepared.plan[number]) => journal.once('eval:pilot:70b:model:' + c.key, 'model', c.request, async () => { calls++; throw Error('private provider error'); });
  try {
    await assert.rejects(run70bPlan(prepared, record.id, invoke), /EFFECT_OUTCOME_UNKNOWN/);
    await assert.rejects(run70bPlan(prepared, record.id, invoke), /EFFECT_OUTCOME_UNKNOWN/);
    assert.equal(calls, 1); assert.equal(journal.effect('eval:pilot:70b:model:' + prepared.plan[0].key).state, 'UNKNOWN');
  } finally { journal.close(); }
});
test('explicit model selection changes only the fixed endpoint; default stays 8B/V1', async () => {
  const c = (await prepare()).plan[0].context; const seen: any[] = [];
  const send: typeof fetch = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(String(options?.body)), redirect: options?.redirect });
    return new Response(JSON.stringify({ success: true, result: { response: 'output' } }));
  };
  await connectModel(env, send).select(c);
  await connectModel(env, send, modelRequestV2, MODEL_70B_ID).select(c);
  assert.equal(seen[0].url.endsWith('/ai/run/' + MODEL_ID), true); assert.deepEqual(seen[0].body, modelRequest(c));
  assert.equal(seen[1].url.endsWith('/ai/run/' + MODEL_70B_ID), true); assert.deepEqual(seen[1].body, modelRequestV2(c));
  assert.equal(seen[1].redirect, 'error');
  assert.throws(() => connectModel(env, send, modelRequestV2, 'https://other.invalid'), /MODEL_NOT_ALLOWED/);
});
test('403 and 429 do not cause retries or fallback to another model', async () => {
  const c = (await prepare()).plan[0].context;
  for (const status of [403, 429]) {
    let calls = 0;
    const model = connectModel(env, async () => { calls++; return new Response('', { status }); }, modelRequestV2, MODEL_70B_ID);
    await assert.rejects(model.select(c), status === 403 ? /MODEL_ACCESS_DENIED/ : /QUOTA_EXHAUSTED/);
    assert.equal(calls, 1);
  }
});
test('unconfirmed 70B CLI stops before loading journal or credentials', () => {
  const file = fileURLToPath(new URL('../scripts/evaluate-70b.ts', import.meta.url));
  const r = spawnSync(process.execPath, ['--experimental-strip-types', file], { env: { ...process.env, RECALL_EVAL_70B_CONFIRMED: 'false' }, encoding: 'utf8' });
  assert.equal(r.status, 2); const report = JSON.parse(r.stdout);
  assert.equal(report.code, 'MODEL70B_NOT_CONFIRMED'); assert.equal(report.modelCallsThisInvocation, 0);
});

test('evaluator accepts a single JSON fence without changing its content or plain responses', () => {
  const body = '{"serviceId":"atlas","reason":"public test","memoryIds":[]}';
  assert.deepEqual(unwrapEvaluatorJson('```json\n' + body + '\n```'), { value: body, envelopeRemoved: true });
  assert.deepEqual(unwrapEvaluatorJson('```json\r\n' + body + '\r\n```'), { value: body, envelopeRemoved: true });
  assert.deepEqual(unwrapEvaluatorJson(body), { value: body, envelopeRemoved: false });
  const object = JSON.parse(body); assert.equal(unwrapEvaluatorJson(object).value, object);
});
test('evaluator rejects prose, multiple fences, malformed JSON and truncated envelopes', () => {
  for (const raw of ['```json\n{}\n```\nprose', '```json\n{}\n```\n```json\n{}\n```',
    '```json\n{broken}\n```', '```json\n{}', '```\n{}\n```']) {
    assert.throws(() => unwrapEvaluatorJson(raw));
  }
});
test('the main parser remains strict and schema checks still reject untrusted decisions', async () => {
  const context = (await prepare()).plan[0].context;
  const fenced = '```json\n{"serviceId":"atlas","reason":"test","memoryIds":[]}\n```';
  assert.throws(() => decision(fenced, context), SyntaxError);
  assert.equal(decision(unwrapEvaluatorJson(fenced).value, context).serviceId, 'atlas');
  for (const raw of ['prose {"serviceId":"atlas"}', '```json\n{"serviceId":"other","reason":"test","memoryIds":[]}\n```',
    '```json\n{"serviceId":"atlas","reason":"test","memoryIds":["invented"]}\n```']) {
    assert.throws(() => decision(unwrapEvaluatorJson(raw).value, context));
  }
});
test('resuming raw DONE response preserves it and completes six arms with only four further calls', async () => {
  const cases = v2Cases(source, source, [record]), prepared = await prepare(), journal = new Journal(':memory:');
  let calls = 0;
  const first = prepared.plan[0], original = '```json\n{"serviceId":"atlas","reason":"test","memoryIds":[]}\n```';
  try {
    await journal.once('eval:pilot:70b:model:' + first.key, 'model', first.request, async () => { calls++; return original; });
    const run = await run70bPlan(prepared, record.id, async c => {
      const value = await journal.once('eval:pilot:70b:model:' + c.key, 'model', c.request, async () => {
        calls++; return JSON.stringify({ serviceId: c.caseId === 'pilot-checkpoint-1' && c.memoryEnabled ? 'beacon' : 'atlas', reason: 'test',
          memoryIds: c.caseId === 'pilot-checkpoint-1' && c.memoryEnabled ? [record.id] : [] });
      });
      return evaluateArm(cases.find(x => x.id === c.caseId)!, { mode: 'fixture', select: async () => unwrapEvaluatorJson(value).value },
        new FrozenMemory([record], 'fixture', ['synthetic-blob']), c.memoryEnabled);
    });
    assert.equal(calls, 5); assert.equal(run.rows.length, 6); assert.equal(run.pairImproved, true);
    assert.equal(JSON.parse(journal.effect('eval:pilot:70b:model:' + first.key).response), original);
  } finally { journal.close(); }
});
test('format continuation needs its separate approval flag before touching inputs', () => {
  const file = fileURLToPath(new URL('../scripts/evaluate-70b.ts', import.meta.url));
  const r = spawnSync(process.execPath, ['--experimental-strip-types', file], { env: { ...process.env,
    RECALL_EVAL_70B_CONFIRMED: 'true', RECALL_EVAL_70B_ENVELOPE_CONFIRMED: 'false' }, encoding: 'utf8' });
  assert.equal(r.status, 2); const report = JSON.parse(r.stdout);
  assert.equal(report.code, 'MODEL70B_ENVELOPE_NOT_CONFIRMED'); assert.equal(report.modelCallsThisInvocation, 0);
});
