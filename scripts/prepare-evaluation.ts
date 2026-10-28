import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, canonical, Fault } from '../src/domain.ts';
import { hash } from '../src/evaluation.ts';
import { buildEvaluationPlan } from '../src/evaluation-plan.ts';

// Pure offline preparation. This command is not authorization for inference.
try {
  const plan = await buildEvaluationPlan(), planHash = hash(plan);
  const directory = '.local/evaluation/benchmark-v1'; mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = directory + '/plan.json';
  if (existsSync(path)) assert(hash(JSON.parse(readFileSync(path, 'utf8'))) === planHash, 'BENCHMARK_PLAN_CHANGED');
  else writeFileSync(path, canonical(plan), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'BENCHMARK_PREPARED_OFFLINE', planHash, modelCalls: 0, tatumCalls: 0, walrusOperations: 0,
    developmentCases: 12, prospectiveCases: 4, logicalModelArms: 32, maximumFutureCalls: plan.callLimit,
    modelId: plan.modelId, maxOutputTokens: 512, requiresSeparateApproval: true }));
} catch (error) {
  console.log(JSON.stringify({ status: 'BENCHMARK_PREPARE_BLOCKED', code: error instanceof Fault ? error.code : 'BENCHMARK_PREPARE_FAILED', modelCalls: 0 }));
  process.exitCode = 2;
}
