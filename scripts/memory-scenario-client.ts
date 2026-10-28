// This fresh process receives only saved public memory bytes and a task/catalog request.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { assert, Fault } from '../src/domain.ts';
import { restoreScenarioContext } from '../src/memory-scenario-context.ts';
globalThis.fetch = async () => { throw new Error('SCENARIO_NETWORK_FORBIDDEN'); };
try {
  assert(process.argv.length === 4 && readdirSync('.').length === 0, 'SCENARIO_CHILD_DIRECTORY_INVALID');
  const allowed = ['NODE_NO_WARNINGS', 'TZ', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
  assert(Object.keys(process.env).every(k => allowed.includes(k)), 'SCENARIO_CHILD_ENV_FORBIDDEN');
  function load(path: string, limit: number) {
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'SCENARIO_CHILD_FILE_INVALID');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  const result = await restoreScenarioContext(load(process.argv[3], 8192), load(process.argv[2], 65536));
  console.log(JSON.stringify({ ...result, processId: process.pid, emptyWorkingDirectory: true,
    credentialEnvironment: 'NONE', inputKinds: ['SAVED_PUBLIC_SNAPSHOT', 'TASK_CATALOG_AND_EXPECTED_HASHES'] }));
} catch (error) {
  console.log(JSON.stringify({ status: 'SCENARIO_RESTORE_BLOCKED', code: error instanceof Fault ? error.code : 'SCENARIO_RESTORE_FAILED', providerCalls: 0 }));
  process.exitCode = 2;
}
