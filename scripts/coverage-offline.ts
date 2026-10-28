import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { assert, Fault } from '../src/domain.ts';
import { CoverageLedger } from '../src/coverage-ledger.ts';
import { executeCoverage } from '../src/coverage-runner.ts';
import { offlineCoveragePorts } from '../src/coverage-offline.ts';
globalThis.fetch = async () => { throw Error('COVERAGE_NETWORK_FORBIDDEN'); };
let ledger: CoverageLedger | undefined;
try {
  assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'COVERAGE_OFFLINE_ARGUMENTS');
  const output = process.argv.length === 4 ? resolve(process.argv[3]) : fileURLToPath(new URL('../.local/coverage-offline-v1/', import.meta.url));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  ledger = new CoverageLedger(join(output, 'coverage-offline.sqlite'));
  const plan = JSON.parse(readFileSync(new URL('../docs/mainnet-eight-plan-v1.json', import.meta.url), 'utf8'));
  const input = JSON.parse(readFileSync(new URL('../evidence/rehearsal-v1/input.json', import.meta.url), 'utf8'));
  const driver = offlineCoveragePorts(input, output);
  const result = await executeCoverage(plan, ledger, driver.ports);
  const report = { ...result, simulatedDriverCallsThisInvocation: driver.stats(), independentProcessesThisInvocation: driver.processChecks,
    ledger: ledger.summary(), instruction: 'Offline only. This CLI has no live/provider binding. Preserve ledger; stopped/interrupted runs cannot resume.' };
  if (!result.reusedCompletedRun) writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, reusedCompletedRun: !!result.reusedCompletedRun, providerApiCalls: 0, mainnetWrites: 0,
    reservations: result.reservations, simulatedDriverCallsThisInvocation: driver.stats(), output }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'OFFLINE_COVERAGE_BLOCKED', code: error instanceof Fault ? error.code : 'COVERAGE_OFFLINE_FAILED',
    ledger: ledger?.summary(), providerApiCalls: 0, mainnetWrites: 0, additionalSpendLimitUSD: 0 })); process.exitCode = 2;
} finally { ledger?.close(); }
