// Default invocation is pure preparation. Future execution needs the exact run-permit and new approval.
import { lstatSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, Fault } from '../src/domain.ts';
import { CoverageLedger } from '../src/coverage-ledger.ts';
import { executeCoverage } from '../src/coverage-runner.ts';
import { COVERAGE_PLAN_HASH } from '../src/coverage-spec.ts';
import { authorizeRun } from '../src/coverage-authorization.ts';
import { adapterPorts } from '../src/coverage-adapters.ts';
import { requestCoverageReader } from '../src/coverage-reader-bridge.ts';
export async function providerCommand(args = process.argv.slice(2), env = process.env) {
  if (!args.length) return { status: 'PROVIDER_BINDING_PREPARED_NOT_EXECUTED', planHash: COVERAGE_PLAN_HASH, providerApiCalls: 0, mainnetWrites: 0 };
  assert(args.length === 5 && args[0] === '--execute' && args[1] === '--permit' && args[3] === '--output', 'COVERAGE_PROVIDER_ARGS');
  const stat = lstatSync(args[2]); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192, 'COVERAGE_PERMIT_FILE');
  const permit = JSON.parse(readFileSync(args[2], 'utf8')); authorizeRun(permit, env, 'writer');
  const output = resolve(args[4]); mkdirSync(output, { recursive: true, mode: 0o700 });
  const ledger = new CoverageLedger(join(output, 'coverage-mainnet.sqlite'));
  try {
    const ports = adapterPorts({ mode: 'LIVE_MAINNET', permit, env,
      clock: { now: () => new Date().toISOString(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
      independentRead: m => requestCoverageReader(resolve(output, '../coverage-readers'), m, permit) });
    const plan = JSON.parse(readFileSync(new URL('../docs/mainnet-eight-plan-v1.json', import.meta.url), 'utf8'));
    const result = await executeCoverage(plan, ledger, ports);
    if (!result.reusedCompletedRun) writeFileSync(join(output, 'report.json'), JSON.stringify({ ...result, ledger: ledger.summary() }, null, 2), { flag: 'wx', mode: 0o600 });
    return result;
  } finally { ledger.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await providerCommand(), null, 2)); }
  catch (error) { console.log(JSON.stringify({ status: 'PROVIDER_EXECUTION_BLOCKED', code: error instanceof Fault ? error.code : 'PROVIDER_EXECUTION_FAILED' })); process.exitCode = 2; }
}
