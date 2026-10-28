import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { assert, Fault } from '../src/domain.ts';
import { hash } from '../src/evaluation.ts';
import { replayPolicy } from '../src/policy-replay.ts';
import { modelRequestV2 } from '../src/evaluation-v2.ts';
import { MODEL_70B_ID } from '../src/providers/model.ts';

try {
  const input = '.local/evaluation/benchmark-v1/report.json';
  assert(existsSync(input) && statSync(input).size <= 524288, 'POLICY_SOURCE_MISSING_OR_LARGE');
  const report = await replayPolicy(JSON.parse(readFileSync(input, 'utf8')));
  const directory = '.local/evaluation/projection-policy-v1'; mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = directory + '/replay.json';
  if (existsSync(path)) assert(hash(JSON.parse(readFileSync(path, 'utf8'))) === hash(report), 'POLICY_REPLAY_CHANGED');
  else writeFileSync(path, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  const requests = report.rows.filter(row => row.replayStatus === 'not_run_changed_request').map(row => {
    assert(row.context, 'POLICY_PENDING_CONTEXT_MISSING');
    const request = { modelId: MODEL_70B_ID, body: modelRequestV2(row.context) };
    assert(hash(request) === row.requestKey, 'POLICY_PENDING_REQUEST_CHANGED');
    return { caseId: row.caseId, memoryEnabled: row.memoryEnabled, key: row.requestKey, request };
  });
  const pending = { mode: 'PREPARED_ONLY_NO_INFERENCE', sourceReportHash: report.sourceReportHash,
    replayHash: hash(report), policy: report.policy, maximumAdditionalCalls: requests.length,
    maxOutputTokens: 512, requiresSeparateApproval: true, requests };
  const pendingPath = directory + '/pending.json';
  if (existsSync(pendingPath)) assert(hash(JSON.parse(readFileSync(pendingPath, 'utf8'))) === hash(pending), 'POLICY_PENDING_PLAN_CHANGED');
  else writeFileSync(pendingPath, JSON.stringify(pending, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'POLICY_REPLAY_BLOCKED', code: error instanceof Fault ? error.code : 'POLICY_REPLAY_FAILED', modelCalls: 0 }));
  process.exitCode = 2;
}
