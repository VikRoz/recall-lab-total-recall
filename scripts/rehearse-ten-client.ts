import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { assert, Fault } from '../src/domain.ts';
import { replayCoverage, completeOriginalReceipts } from '../src/rehearsal-coverage.ts';
globalThis.fetch = async () => { throw new Error('REHEARSAL_NETWORK_FORBIDDEN'); };
try {
  assert(process.argv.length === 4 && readdirSync('.').length === 0
    && !existsSync('.local') && !existsSync('stage0.sqlite'), 'REHEARSAL_TEN_CHILD_DIRECTORY_INVALID');
  // macOS adds its text-encoding variable even when spawn receives an explicit two-key environment.
  const allowed = ['NODE_NO_WARNINGS', 'TZ', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
  assert(Object.keys(process.env).every(k => allowed.includes(k)), 'REHEARSAL_TEN_CHILD_ENV_FORBIDDEN');
  const result = completeOriginalReceipts(await replayCoverage(JSON.parse(readFileSync(process.argv[2], 'utf8'))),
    JSON.parse(readFileSync(process.argv[3], 'utf8')));
  console.log(JSON.stringify({ ...result, processId: process.pid, emptyWorkingDirectory: true,
    credentialEnvironment: 'NONE', executionMode: 'NEW_LOCAL_PROCESS_NO_REMOTE_RECALL' }));
} catch (error) {
  console.log(JSON.stringify({ status: 'REHEARSAL_TEN_CHILD_BLOCKED', code: error instanceof Fault ? error.code : 'REHEARSAL_TEN_CHILD_FAILED' }));
  process.exitCode = 2;
}
