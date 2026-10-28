import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Journal } from '../src/local-journal.ts';
import { hash } from '../src/evaluation.ts';
import { authorizeProbe, executeProbe, probePermit, PROBE_PREFIX } from '../src/scenario-probe.ts';
import { probeCommand } from '../scripts/probe-memory-scenario.ts';
const prepared = JSON.parse(readFileSync(new URL('../evidence/scenario-probe-v1/prepared-report.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(readFileSync(new URL('../evidence/scenario-probe-v1/prepared-scenario.json', import.meta.url), 'utf8'));
function setup() {
  const permit = probePermit(prepared, { accountIdHash: hash('1'.repeat(32)), sourceHash: '2'.repeat(64), runtimeImageId: 'sha256:' + '3'.repeat(64) });
  const env = { RECALL_SCENARIO_PROBE_APPROVED_HASH: hash(permit), RECALL_SCENARIO_PROBE_ZERO_SPEND_HASH: hash(permit),
    RECALL_FREE_TIER_CONFIRMED: 'true', RECALL_RUNTIME_IMAGE_ID: permit.runtimeImageId, RECALL_PROBE_SOURCE_HASH: permit.sourceHash,
    CLOUDFLARE_ACCOUNT_ID: '1'.repeat(32), CLOUDFLARE_API_TOKEN: 'offline-dummy-not-a-real-token' };
  return { permit, env };
}
test('bare probe command is inert and changing approval, model, caps or account stops before invocation', async () => {
  assert.equal((await probeCommand([], {})).status, 'SCENARIO_PROBE_PREPARED_NOT_EXECUTED');
  const { permit, env } = setup(); assert.equal(authorizeProbe(prepared, permit, env), hash(permit));
  assert.throws(() => authorizeProbe(prepared, permit, {}), /APPROVAL_REQUIRED/);
  for (const changed of [{ ...permit, maxNewModelCalls: 6 }, { ...permit, modelId: 'other' }, { ...permit, retries: 1 },
    { ...permit, extra: 'not-allowed' }]) assert.throws(() => authorizeProbe(prepared, changed, env));
  assert.throws(() => authorizeProbe(prepared, permit, { ...env, CLOUDFLARE_ACCOUNT_ID: '4'.repeat(32) }), /CREDENTIALS_INVALID/);
  assert.throws(() => authorizeProbe(prepared, permit, { ...env, TATUM_API_KEY: 'forbidden' }), /EXCESS_CREDENTIALS/);
});
test('exactly five reserved mock effects score nine shared arms; incorrect proposals and guard remain distinct', async () => {
  const { permit, env } = setup(), j = new Journal(':memory:'); let calls = 0;
  try {
    const r = await executeProbe({ prepared, scenario, permit, env, journal: j, progress: () => {},
      invoke: async request => {
        assert.equal(j.effect(PROBE_PREFIX + hash(request)).state, 'IN_FLIGHT'); calls++;
        return { serviceId: 'atlas', reason: 'Deliberately wrong local model-port control.', memoryIds: [] };
      } });
    assert.equal(calls, 5); assert.equal(r.status, 'SCENARIO_PROBE_COMPLETED'); assert.equal(r.completedUniqueResponses, 5);
    assert.equal(r.rows.flatMap((x: any) => x.arms).length, 9);
    const b = r.rows[0].arms[1]; assert.equal(b.controllerOutcome, 'BLOCKED'); assert.equal(b.goalCompleted, false);
    assert.equal(b.rawVerifier.status, 'fail'); assert.deepEqual(b.proposal.memoryIds, []);
    assert.equal(r.rows[0].arms[1].rawResponseHash, r.rows[0].arms[2].rawResponseHash);
    await assert.rejects(executeProbe({ prepared, scenario, permit, env, journal: j, progress: () => {}, invoke: async () => { calls++; return {}; } }), /JOURNAL_NOT_FRESH/);
    assert.equal(calls, 5);
  } finally { j.close(); }
});
test('lost provider outcome consumes one reservation, becomes UNKNOWN and stops without retry', async () => {
  const { permit, env } = setup(), j = new Journal(':memory:'); let calls = 0;
  try {
    const r = await executeProbe({ prepared, scenario, permit, env, journal: j, progress: () => {},
      invoke: async () => { calls++; throw new Error('safe-offline-timeout'); } });
    assert.equal(calls, 1); assert.equal(r.status, 'SCENARIO_PROBE_STOPPED'); assert.equal(r.requestsReserved, 1);
    assert.equal(j.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE state='UNKNOWN'").get()!.n, 1);
    assert.equal(r.rows.every((x: any) => x.arms.every((a: any) => a.status === 'NOT_RUN')), true);
  } finally { j.close(); }
});
test('malformed known responses are retained and scored, never repaired or promoted to success', async () => {
  const { permit, env } = setup(), j = new Journal(':memory:');
  try {
    const r = await executeProbe({ prepared, scenario, permit, env, journal: j, progress: () => {},
      invoke: async () => '```json\n{"serviceId":"atlas","reason":"test","memoryIds":[]}\n```' });
    assert.equal(r.status, 'SCENARIO_PROBE_COMPLETED');
    assert.equal(r.rows.every((x: any) => x.arms.every((a: any) => a.status === 'MODEL_RESPONSE_INVALID')), true);
    assert.equal(j.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE state='DONE'").get()!.n, 5);
  } finally { j.close(); }
});
