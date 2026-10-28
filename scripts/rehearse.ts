import { lstatSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assert, Fault } from '../src/domain.ts';
import { runRehearsal, REHEARSAL_INPUT_HASH } from '../src/rehearsal.ts';
import { rehearsalHtml, rehearsalRunbook } from '../src/rehearsal-view.ts';

globalThis.fetch = async () => { throw new Error('REHEARSAL_NETWORK_FORBIDDEN'); };
export async function rehearse(evidencePath: string) {
  const path = resolve(evidencePath), stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536, 'REHEARSAL_INPUT_FILE_INVALID');
  const report = await runRehearsal(JSON.parse(readFileSync(path, 'utf8')));
  const directory = mkdtempSync(join(tmpdir(), 'recall-rehearsal-new-client-'));
  try {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./rehearse-client.ts', import.meta.url)), path], {
      cwd: directory, env: { NODE_NO_WARNINGS: '1', TZ: 'UTC' }, encoding: 'utf8', timeout: 15000, maxBuffer: 131072,
    });
    assert(!child.error && child.status === 0, 'REHEARSAL_NEW_PROCESS_FAILED');
    const fresh = JSON.parse(child.stdout);
    assert(fresh.status === 'OFFLINE_NEW_PROCESS_REPLAY_VERIFIED' && fresh.evidenceHash === REHEARSAL_INPUT_HASH
      && fresh.processId === child.pid && fresh.processId !== process.pid, 'REHEARSAL_CHILD_PROOF_INVALID');
    // Process IDs are execution attestation only; the replay data and decisions are deterministic.
    return { ...report, status: 'UNIFIED_REHEARSAL_VERIFIED', episodes: [...report.episodes, fresh],
      independentProcess: { checked: true, parentProcessId: process.pid, childProcessId: fresh.processId,
        credentialEnvironment: 'NONE', input: 'PUBLIC_SAVED_EVIDENCE', remoteRecallThisRun: false } };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'REHEARSAL_ARGUMENTS_INVALID');
    const output = process.argv.length === 4 ? resolve(process.argv[3]) : fileURLToPath(new URL('../dist/rehearsal-v1/', import.meta.url));
    const evidence = fileURLToPath(new URL('../evidence/rehearsal-v1/input.json', import.meta.url));
    const report = await rehearse(evidence);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(output, 'index.html'), rehearsalHtml(report));
    writeFileSync(join(output, 'RUNBOOK.md'), rehearsalRunbook(report));
    console.log(JSON.stringify({ status: report.status, mode: report.mode, episodes: report.episodes.length,
      providerCalls: report.providerCalls, additionalSpendLimitUSD: 0, outputs: output,
      independentProcess: report.independentProcess }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ status: 'REHEARSAL_BLOCKED', code: error instanceof Fault ? error.code : 'REHEARSAL_FAILED', providerCalls: 0 }));
    process.exitCode = 2;
  }
}
