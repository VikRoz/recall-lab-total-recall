import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

function run(command, args, timeout = 15000) {
  return spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
}
const tests = run(process.execPath, ['--experimental-strip-types', '--test', ...readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => 'test/' + f)]);
const syntax = run(process.execPath, ['scripts/check.mjs']);
const preview = run(process.execPath, ['--experimental-strip-types', 'scripts/build-preview.ts']);
const doctor = run(process.execPath, ['--experimental-strip-types', 'scripts/doctor.ts']);
const setup = JSON.parse(doctor.stdout);
let standaloneValid = false;
if (preview.status === 0) {
  const html = readFileSync('dist/recall-lab-preview.html', 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (script) standaloneValid = !script.includes("fetch('/api/") && spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8' }).status === 0;
}
const report = {
  generatedAt: new Date().toISOString(), stage: 0,
  offline: { status: tests.status === 0 && syntax.status === 0 && standaloneValid ? 'PASS' : 'FAIL',
    testsPassed: Number(tests.stdout.match(/# pass (\d+)/)?.[1] ?? 0), testsFailed: Number(tests.stdout.match(/# fail (\d+)/)?.[1] ?? 0),
    syntaxCheck: syntax.status === 0 ? 'PASS' : 'FAIL', fullTypeCheck: 'NOT_RUN',
    standalonePreview: standaloneValid ? 'PASS' : 'FAIL', browserVisualQA: 'NOT_RUN' },
  setup, network: { npm: 'NOT_PROBED', walrusHealth: 'NOT_PROBED' },
  liveAcceptance: 'BLOCKED', modelCalls: 0, mainnetWrites: 0, additionalSpendLimitUSD: 0,
};
if (process.argv.includes('--network')) {
  const npm = run('npm', ['view', '@mysten-incubation/memwal', 'version', '--json', '--cache', '/tmp/recall-stage0-npm', '--fetch-retries=0', '--fetch-timeout=5000'], 8000);
  report.network.npm = npm.status === 0 ? 'REGISTRY_REACHABLE_UNVERIFIED' : /ENOTFOUND/.test(npm.stderr) ? 'ENOTFOUND' : 'NETWORK_CHECK_FAILED';
  const health = run(process.execPath, ['--input-type=module', '-e', "try{const r=await fetch('https://relayer.memory.walrus.xyz/health',{signal:AbortSignal.timeout(5000)});console.log(r.status)}catch(e){console.log(e.cause?.code??e.name);process.exitCode=2}"], 8000);
  report.network.walrusHealth = health.status === 0 ? 'HTTP_' + health.stdout.trim() : health.stdout.includes('ENOTFOUND') ? 'ENOTFOUND' : 'NETWORK_CHECK_FAILED';
}
mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/stage0-latest.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.offline.status === 'PASS' ? 2 : 1;
