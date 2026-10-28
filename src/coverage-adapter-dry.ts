import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, canonical, time } from './domain.ts';
import { adapterPorts } from './coverage-adapters.ts';
import { AdapterStubBackend, stubTatum } from './coverage-adapter-stubs.ts';
import { BASE_EXPECTED, hash } from './coverage-spec.ts';
export function adapterDryDriver(input: any, directory: string) {
  assert(hash(input) === '89efc4d0a5ecbd614b3582b96252ac65b1e56af2cdb1119194310b5b2d969dac', 'COVERAGE_DRY_INPUT_CHANGED');
  const records = [input.stage0.record, input.correction.probe.record];
  const backend = new AdapterStubBackend(BASE_EXPECTED.map(e => ({ blobId: e.blobId, text: canonical(records.find(r => r.id === e.id)) })));
  const tatum = stubTatum(input.correction.probe.source);
  let now = time(input.correction.probe.source.asOf) + 1000, memoryConnections = 0, tatumConnections = 0;
  const readers: any[] = [];
  const ports = adapterPorts({ mode: 'ADAPTER_DRY_RUN', clock: { now: () => new Date(now).toISOString(), sleep: async ms => { now += ms; } },
    factories: { memory: async () => { memoryConnections++; return backend.adapter(); }, tatum: async () => { tatumConnections++; return tatum.adapter; } },
    independentRead: async manifest => {
      const dir = join(directory, 'readers', manifest.wave); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, 'public-input.json'); writeFileSync(path, JSON.stringify({ manifest, rows: backend.rows }), { flag: 'wx', mode: 0o600 });
      const child = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../scripts/coverage-provider-reader.ts', import.meta.url)), '--dry-input', path], {
        cwd: dir, env: { NODE_NO_WARNINGS: '1', TZ: 'UTC' }, timeout: 20000, maxBuffer: 262144, encoding: 'utf8',
      });
      assert(!child.error && child.status === 0, 'COVERAGE_ADAPTER_READER_FAILED');
      const r = JSON.parse(child.stdout); assert(r.processId === child.pid && child.pid !== process.pid, 'COVERAGE_ADAPTER_READER_PID');
      readers.push({ wave: manifest.wave, pid: child.pid, stubClientCalls: r.stubClientCalls }); return r;
    } });
  return { ports, backend, tatum, readers, stats: () => ({ memoryConnections, tatumConnections, closedTatum: tatum.closed(),
    checkpointCalls: tatum.requests.length, parentStubClientCalls: { ...backend.counts } }) };
}
