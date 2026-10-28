import { readFileSync, lstatSync, writeFileSync, existsSync } from 'node:fs';
import { assert, Fault } from '../src/domain.ts';
import { readCoverage } from '../src/coverage-spec.ts';
import { OfflineMemory } from '../src/coverage-offline.ts';
globalThis.fetch = async () => { throw Error('COVERAGE_NETWORK_FORBIDDEN'); };
try {
  assert(process.argv.length === 3, 'COVERAGE_READER_ARGUMENTS');
  assert(!process.env.MEMWAL_KEY && !process.env.TATUM_API_KEY && !process.env.CLOUDFLARE_API_TOKEN, 'COVERAGE_READER_CREDENTIALS');
  assert(!existsSync('coverage-offline.sqlite') && !existsSync('stage0.sqlite'), 'COVERAGE_READER_DATABASE');
  const stat = lstatSync(process.argv[2]); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072, 'COVERAGE_READER_INPUT');
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  writeFileSync('reader-attempt.json', JSON.stringify({ mode: 'OFFLINE_FIXTURE', wave: input.manifest.wave }), { flag: 'wx', mode: 0o600 });
  const result = await readCoverage(new OfflineMemory(input.snapshot), input.manifest);
  writeFileSync('reader-result.json', JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...result, processId: process.pid }));
} catch (error) { console.log(JSON.stringify({ status: 'OFFLINE_READER_BLOCKED', code: error instanceof Fault ? error.code : 'COVERAGE_READER_FAILED' })); process.exitCode = 2; }
