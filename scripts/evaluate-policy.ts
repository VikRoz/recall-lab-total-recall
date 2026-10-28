import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, Fault } from '../src/domain.ts';
import { buildEvaluationPlan } from '../src/evaluation-plan.ts';
import { deterministicModel, evaluateArm, FrozenMemory, hash } from '../src/evaluation.ts';
import { PROJECTION_POLICY } from '../src/projection-policy.ts';

try {
  const plan = await buildEvaluationPlan(), rows = [];
  for (const c of plan.cases) for (const enabled of [false, true]) {
    rows.push({ selector: 'deterministic-fixture', ...await evaluateArm(c, deterministicModel,
      new FrozenMemory(c.records), enabled, { projectionPolicy: PROJECTION_POLICY }) });
  }
  const budget = plan.cases.find(c => c.id === 'evidence-budget-only-bad')!;
  const adversarial = await evaluateArm(budget, { mode: 'fixture', select: async () => ({ serviceId: 'atlas',
    reason: 'Adversarial fixture: proposes the known failing cheapest projection.', memoryIds: [] }) },
  new FrozenMemory(budget.records), true, { projectionPolicy: PROJECTION_POLICY });
  assert(adversarial.executionStatus === 'BLOCKED' && adversarial.serviceProjections === 0
    && adversarial.demoCredits === '0' && adversarial.decision?.memoryIds.length === 0, 'POLICY_REGRESSION_FAILED');
  const report = { status: 'POLICY_FIXTURE_COMPLETED', mode: 'DETERMINISTIC_FIXTURE_ONLY', policy: PROJECTION_POLICY,
    legacyPlanHash: hash(plan), modelCalls: 0, tatumCalls: 0, walrusOperations: 0, legacyControls: plan.controls, rows, adversarial,
    limitations: ['All selections are explicit deterministic/adversarial fixtures, not LLM results.'] };
  const directory = '.local/evaluation/projection-policy-v1'; mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = directory + '/fixtures.json';
  if (existsSync(path)) assert(hash(JSON.parse(readFileSync(path, 'utf8'))) === hash(report), 'POLICY_FIXTURE_CHANGED');
  else writeFileSync(path, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'POLICY_FIXTURE_BLOCKED', code: error instanceof Fault ? error.code : 'POLICY_FIXTURE_FAILED', modelCalls: 0 }));
  process.exitCode = 2;
}
