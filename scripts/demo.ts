import { pathToFileURL } from 'node:url';
import { cycle, observation } from '../src/agent.ts';
import { offers, task, service, reference, FixtureMemory, FixtureModel, newBacking } from '../src/fixtures.ts';
import { canonical } from '../src/domain.ts';
import { PROJECTION_POLICY } from '../src/projection-policy.ts';

export async function runDemo() {
  const backing = newBacking();
  const run = async (id: string, memoryOn: boolean, family = 'evidence', catalog = offers, minute = 0, requiredFields?: string[]) => {
    const t = task(id, family, `2026-10-24T12:0${minute}:00.000Z`);
    if (requiredFields) t.requiredFields = requiredFields;
    const memory = new FixtureMemory(backing); // a fresh client, not a shared chat context
    const output = await cycle(t, catalog, { model: new FixtureModel(), memory, service,
      serviceScope: 'controlled-demo-projection', reference: async () => reference(t) }, memoryOn,
    { projectionPolicy: PROJECTION_POLICY });
    return { task: t, output };
  };
  const first = await run('first', false);
  const writer = new FixtureMemory(backing);
  await writer.remember(canonical(observation(first.task, first.output, '2026-10-24T12:00:01.000Z')), 'experience:first');
  const withMemory = await run('remembered', true, 'evidence', offers, 1);
  const withoutMemory = await run('baseline', false, 'evidence', offers, 1);
  const otherTask = await run('ownership', true, 'evidence', offers, 2, ['owner']);
  const repairedOffers = offers.map(o => o.id === 'atlas' ? { ...o, version: 'v2' } : o);
  const newVersion = await run('new-version', true, 'evidence', repairedOffers, 3);
  return { mode: 'DETERMINISTIC_FIXTURE', projectionPolicy: PROJECTION_POLICY,
    chainData: 'SYNTHETIC', memory: 'IN_PROCESS_FIXTURE', modelCalls: 0, mainnetWrites: 0,
    faultInjection: 'Atlas v1 claims objectType support but omits that field for evidence tasks.',
    episodes: [first, withMemory, withoutMemory, otherTask, newVersion],
    claims: 'Offline contract demonstration only. No live model, Tatum, Walrus, D1 or cross-runtime portability acceptance.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runDemo(), null, 2));
