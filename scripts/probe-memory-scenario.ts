import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, canonical, Fault } from '../src/domain.ts';
import { hash } from '../src/evaluation.ts';
import { buildMemoryScenario } from '../src/memory-scenario.ts';
import { authorizeProbe, executeProbe, SCENARIO_INPUT_PLAN_HASH } from '../src/scenario-probe.ts';
import { Journal } from '../src/local-journal.ts';
import { connectModel, MODEL_ID } from '../src/providers/model.ts';
function read(path: string, limit = 131072) {
  const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'PROBE_INPUT_FILE_INVALID');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export async function probeCommand(args = process.argv.slice(2), env = process.env) {
  if (!args.length) return { status: 'SCENARIO_PROBE_PREPARED_NOT_EXECUTED', inputPlanHash: SCENARIO_INPUT_PLAN_HASH,
    maxModelCallsAfterNewApproval: 5, providerCallsThisInvocation: 0 };
  assert(args.length === 5 && args[0] === '--execute' && args[1] === '--permit' && args[3] === '--output', 'PROBE_ARGUMENTS_INVALID');
  const permit = read(resolve(args[2]), 8192), output = resolve(args[4]);
  const base = fileURLToPath(new URL('../evidence/', import.meta.url));
  const prepared = read(join(base, 'scenario-probe-v1/prepared-report.json'));
  const scenario = read(join(base, 'scenario-probe-v1/prepared-scenario.json'));
  const rebuilt = buildMemoryScenario(read(join(base, 'rehearsal-v1/input.json'), 65536),
    read(join(base, 'coverage-mainnet-v1/live-evidence.json')));
  assert(canonical(rebuilt) === canonical(scenario), 'PROBE_SOURCE_SCENARIO_CHANGED');
  const permitHash = authorizeProbe(prepared, permit, env);
  const completed = join(output, 'report.json'), started = join(output, 'attempt.started');
  if (existsSync(completed)) {
    const cached = read(completed, 262144);
    assert(cached.status === 'SCENARIO_PROBE_COMPLETED' && cached.permitHash === permitHash, 'PROBE_EXISTING_RESULT_CHANGED');
    return { ...cached, cachedInspection: true, providerCallsThisInvocation: 0 };
  }
  assert(!existsSync(started) && !existsSync(join(output, 'journal.sqlite')), 'PROBE_ALREADY_STARTED_OR_INTERRUPTED');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(started, JSON.stringify({ permitHash, inputPlanHash: SCENARIO_INPUT_PLAN_HASH }), { flag: 'wx', mode: 0o600 });
  const j = new Journal(join(output, 'journal.sqlite')); j.db.exec('PRAGMA synchronous=FULL;');
  let providerStatus: number | null = null;
  const model = connectModel(env, async (url, options) => {
    const response = await fetch(url, options); providerStatus = response.status; return response;
  });
  try {
    const result = await executeProbe({ prepared, scenario, permit, env, journal: j,
      invoke: async request => {
        assert(request.modelId === MODEL_ID, 'PROBE_MODEL_CHANGED');
        return model.select(JSON.parse(request.body.messages[1].content));
      }, progress: value => writeFileSync(join(output, 'progress.json'), JSON.stringify({ ...value, lastProviderStatus: providerStatus }, null, 2), { mode: 0o600 }),
    });
    const report = { ...result, lastProviderStatus: providerStatus,
      effects: j.db.prepare('SELECT id,kind,hash,state,response FROM effects ORDER BY rowid').all() };
    writeFileSync(result.status === 'SCENARIO_PROBE_COMPLETED' ? completed : join(output, 'stopped.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return report;
  } finally { j.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeCommand();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'SCENARIO_PROBE_STOPPED') process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify({ status: 'SCENARIO_PROBE_BLOCKED', code: error instanceof Fault ? error.code : 'PROBE_FAILED' }));
    process.exitCode = 2;
  }
}
