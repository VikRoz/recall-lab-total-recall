import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { assert, Fault } from '../src/domain.ts';
import { hash } from '../src/evaluation.ts';
import { rehearseTen } from './rehearse-ten.ts';
import { publicDemoData } from '../src/public-demo.ts';
import { publicDemoHtml } from '../src/public-demo-view.ts';

globalThis.fetch = async () => { throw new Error('PUBLIC_DEMO_NETWORK_FORBIDDEN'); };
const root = fileURLToPath(new URL('../', import.meta.url));
function json(name: string) {
  const p = join(root, name), s = lstatSync(p);
  assert(s.isFile() && !s.isSymbolicLink() && s.size < 262144, 'PUBLIC_DEMO_FILE_INVALID');
  return JSON.parse(readFileSync(p, 'utf8'));
}
export async function buildPublicDemo(output: string) {
  const rehearsal = await rehearseTen(join(root, 'evidence/rehearsal-v1/input.json'),
    join(root, 'evidence/coverage-mainnet-v1/live-evidence.json'));
  const live = json('evidence/scenario-probe-v1/live-report.json');
  const data = publicDemoData(rehearsal, json('evidence/scenario-probe-v1/prepared-report.json'),
    json('evidence/scenario-probe-v1/prepared-scenario.json'), json('deploy/scenario-probe-run-v1.json'), live);
  const html = publicDemoHtml(data, readFileSync(join(root, 'public-demo/style.css'), 'utf8'),
    readFileSync(join(root, 'public-demo/client.js'), 'utf8'));
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'index.html'), html);
  writeFileSync(join(output, 'demo-data.json'), JSON.stringify(data, null, 2));
  writeFileSync(join(output, 'model-report.json'), JSON.stringify(live, null, 2));
  writeFileSync(join(output, 'verification.json'), JSON.stringify({ status: 'PUBLIC_DEMO_OFFLINE_PREPARED',
    dataHash: hash(data), verifiedRecords: data.records.length, correctionChains: data.chains.length,
    modelCallsThisBuild: 0, providerCallsThisBuild: 0, mainnetWritesThisBuild: 0, additionalSpendUSD: 0,
    networkPolicy: 'CONNECT_NONE_NO_EXTERNAL_ASSETS', publication: 'NOT_PUBLISHED',
    freshLocalProcessVerified: true, remoteRecallThisBuild: false }, null, 2));
  for (const [source, target] of [['PACKAGE-README.md', 'README.md'], ['RUNBOOK.md', 'RUNBOOK.md'], ['verify.mjs', 'verify.mjs']])
    writeFileSync(join(output, target), readFileSync(join(root, 'public-demo', source)));
  const names = ['index.html', 'demo-data.json', 'model-report.json', 'verification.json', 'README.md', 'RUNBOOK.md', 'verify.mjs'];
  writeFileSync(join(output, 'CHECKSUMS.json'), JSON.stringify(Object.fromEntries(names.map(name =>
    [name, createHash('sha256').update(readFileSync(join(output, name))).digest('hex')])), null, 2));
  return data;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'PUBLIC_DEMO_ARGUMENTS');
    const output = process.argv.length === 4 ? resolve(process.argv[3]) : join(root, 'dist/public-demo-v1');
    const data = await buildPublicDemo(output);
    console.log(JSON.stringify({ status: 'PUBLIC_DEMO_OFFLINE_PREPARED', output,
      verifiedRecords: data.records.length, correctionChains: data.chains.length, totals: data.totals,
      providerCalls: 0, additionalSpendUSD: 0, published: false }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ status: 'PUBLIC_DEMO_BLOCKED', code: error instanceof Fault ? error.code : 'PUBLIC_DEMO_FAILED', providerCalls: 0 }));
    process.exitCode = 2;
  }
}
