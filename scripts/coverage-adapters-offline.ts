import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { assert, Fault } from '../src/domain.ts';
import { CoverageLedger } from '../src/coverage-ledger.ts';
import { executeCoverage } from '../src/coverage-runner.ts';
import { adapterDryDriver } from '../src/coverage-adapter-dry.ts';
globalThis.fetch = async () => { throw Error('COVERAGE_ADAPTER_DRY_NETWORK_FORBIDDEN'); };
let ledger: CoverageLedger | undefined;
try {
  const args = process.argv.slice(2); assert(!args.length || (args.length === 2 && args[0] === '--output'), 'COVERAGE_ADAPTER_DRY_ARGS');
  const output = args.length ? resolve(args[1]) : fileURLToPath(new URL('../.local/coverage-adapter-dry-v1/', import.meta.url));
  mkdirSync(output, { recursive: true, mode: 0o700 }); ledger = new CoverageLedger(join(output, 'coverage-offline.sqlite'));
  const plan = JSON.parse(readFileSync(new URL('../docs/mainnet-eight-plan-v1.json', import.meta.url), 'utf8'));
  const input = JSON.parse(readFileSync(new URL('../evidence/rehearsal-v1/input.json', import.meta.url), 'utf8'));
  const d = adapterDryDriver(input, output), result = await executeCoverage(plan, ledger, d.ports);
  const report = { ...result, adapterStatsThisInvocation: d.stats(), readersThisInvocation: d.readers, ledger: ledger.summary(),
    disclosure: 'Actual TatumData/WalrusMemory classes, stub clients and virtual clocks; no SDK preflights, API calls or Mainnet writes.' };
  if (!result.reusedCompletedRun) writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, reusedCompletedRun: !!result.reusedCompletedRun, providerApiCalls: 0, mainnetWrites: 0,
    reservations: result.reservations, adapterStatsThisInvocation: d.stats(), output }, null, 2));
} catch (error) { console.log(JSON.stringify({ status: 'ADAPTER_DRY_RUN_BLOCKED', code: error instanceof Fault ? error.code : 'ADAPTER_DRY_FAILED' })); process.exitCode = 2; }
finally { ledger?.close(); }
