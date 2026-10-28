// The parent starts this file in a new empty directory and passes public saved evidence only.
import { readFileSync, existsSync } from 'node:fs';
import { assert, Fault } from '../src/domain.ts';
import { runFreshRehearsal } from '../src/rehearsal.ts';
globalThis.fetch = async () => { throw new Error('REHEARSAL_NETWORK_FORBIDDEN'); };
try {
  assert(process.argv.length === 3 && !existsSync('.local') && !existsSync('stage0.sqlite'), 'REHEARSAL_CHILD_INPUT_INVALID');
  assert(!process.env.MEMWAL_KEY && !process.env.TATUM_API_KEY && !process.env.CLOUDFLARE_API_TOKEN, 'REHEARSAL_CHILD_CREDENTIALS_FORBIDDEN');
  const result = await runFreshRehearsal(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify({ ...result, processId: process.pid, executionMode: 'NEW_LOCAL_PROCESS_NO_REMOTE_RECALL' }));
} catch (error) {
  console.log(JSON.stringify({ status: 'REHEARSAL_CHILD_BLOCKED', code: error instanceof Fault ? error.code : 'REHEARSAL_CHILD_FAILED' }));
  process.exitCode = 2;
}
