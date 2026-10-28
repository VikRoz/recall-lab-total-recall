import { readFileSync, lstatSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { assert, Fault } from '../src/domain.ts';
import { hash, readCoverage, validateManifest } from '../src/coverage-spec.ts';
import { authorizeRun } from '../src/coverage-authorization.ts';
import { AdapterStubBackend } from '../src/coverage-adapter-stubs.ts';
try {
  assert(process.argv.length === 4 && ['--dry-input', '--request'].includes(process.argv[2]), 'COVERAGE_PROVIDER_READER_ARGS');
  const path = process.argv[3], stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072, 'COVERAGE_PROVIDER_READER_FILE');
  const request = JSON.parse(readFileSync(path, 'utf8')); validateManifest(request.manifest);
  assert(!existsSync('coverage-mainnet.sqlite') && !existsSync('coverage-offline.sqlite') && !existsSync('stage0.sqlite'), 'COVERAGE_READER_DATABASE');
  const dry = process.argv[2] === '--dry-input';
  if (dry) {
    assert(request.manifest.mode === 'ADAPTER_DRY_RUN' && !process.env.MEMWAL_KEY && !process.env.TATUM_API_KEY, 'COVERAGE_DRY_READER_CREDENTIALS');
    globalThis.fetch = async () => { throw Error('COVERAGE_DRY_NETWORK_FORBIDDEN'); };
  } else {
    authorizeRun(request.permit, process.env, 'reader');
    assert(request.manifest.mode === 'LIVE_MAINNET' && request.manifest.runPermitHash === hash(request.permit), 'COVERAGE_READER_PERMIT_CHANGED');
  }
  writeFileSync('reader-attempt.json', JSON.stringify({ mode: request.manifest.mode, manifestHash: hash(request.manifest) }), { flag: 'wx', mode: 0o600 });
  // No writer journal/proof imports; fresh SDK client only after authorization and one-shot claim.
  const backend = dry ? new AdapterStubBackend(request.rows) : undefined;
  const memory = backend ? backend.adapter() : await (await import('../src/providers/walrus.ts')).connectWalrus(process.env);
  const result = { ...await readCoverage(memory, request.manifest), processId: process.pid,
    ...(backend ? { stubClientCalls: backend.counts } : {}) };
  writeFileSync('response.tmp', JSON.stringify(result), { flag: 'wx', mode: 0o600 }); renameSync('response.tmp', 'response.json');
  console.log(JSON.stringify(result));
} catch (error) { console.log(JSON.stringify({ status: 'PROVIDER_READER_BLOCKED', code: error instanceof Fault ? error.code : 'PROVIDER_READER_FAILED' })); process.exitCode = 2; }
