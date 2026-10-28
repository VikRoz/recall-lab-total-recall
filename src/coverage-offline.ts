// Deliberately offline-only driver. No SDK, provider adapter, URL or credential loading.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, canonical, experience, time } from './domain.ts';
import type { Snapshot } from './domain.ts';
import type { MemoryPort, Receipt } from './memory.ts';
import { BASE_EXPECTED, hash, readCoverage } from './coverage-spec.ts';
import type { Manifest } from './coverage-spec.ts';
import type { CoveragePorts } from './coverage-runner.ts';

export class OfflineMemory implements MemoryPort {
  mode = 'fixture' as const;
  rows: { blobId: string; text: string }[];
  jobs = new Map<string, { payload: string; key: string; slot: number; polls: number; pending: number }>();
  counts = { inventory: 0, recall: 0, remember: 0, status: 0 };
  pendingPerJob: number;
  constructor(rows: { blobId: string; text: string }[], pendingPerJob = 0) { this.rows = structuredClone(rows); this.pendingPerJob = pendingPerJob; }
  async inventory() { this.counts.inventory++; return { blobIds: this.rows.map(r => r.blobId), revision: hash(this.rows) }; }
  async recall(_q: string, n: number) { this.counts.recall++; return structuredClone(this.rows.slice(0, n)); }
  async remember(payload: string, key: string) {
    this.counts.remember++; const slot = Number(key.split(':').at(-1));
    assert(![...this.jobs.values()].some(j => j.key === key), 'OFFLINE_DUPLICATE_SUBMISSION');
    const jobId = 'fixture-job-' + slot;
    this.jobs.set(jobId, { payload, key, slot, polls: 0, pending: this.pendingPerJob }); return { jobId };
  }
  async status(jobId: string): Promise<Receipt> {
    this.counts.status++; const job = this.jobs.get(jobId); assert(job, 'OFFLINE_JOB_MISSING'); job.polls++;
    if (job.polls <= job.pending) return { state: 'pending', jobId };
    const blobId = 'SIMULATED_BLOB_coverage_' + job.slot;
    if (!this.rows.some(r => r.blobId === blobId)) this.rows.push({ blobId, text: job.payload });
    return { state: 'done', jobId, blobId };
  }
}
export function offlineCoveragePorts(input: any, directory: string, options: { pendingPerJob?: number; childProcesses?: boolean } = {}) {
  assert(hash(input) === '89efc4d0a5ecbd614b3582b96252ac65b1e56af2cdb1119194310b5b2d969dac', 'COVERAGE_OFFLINE_INPUT_CHANGED');
  const baseline = [input.stage0.record, input.correction.probe.record];
  const rows = BASE_EXPECTED.map(e => {
    const record = baseline.find(r => r.id === e.id); assert(record && hash(experience(record)) === e.hash, 'COVERAGE_OFFLINE_BASE_CHANGED');
    return { blobId: e.blobId, text: canonical(record) };
  });
  const memory = new OfflineMemory(rows, options.pendingPerJob ?? 0), source: Snapshot = structuredClone(input.correction.probe.source);
  let now = time(source.asOf) + 1000, checkpointCalls = 0, closed = 0;
  const processChecks: { wave: string; pid: number; parentPid: number }[] = [];
  const ports: CoveragePorts = { mode: 'OFFLINE_FIXTURE', memory,
    clock: { now: () => new Date(now).toISOString(), sleep: async ms => { now += ms; } },
    checkpoint: async sequence => { checkpointCalls++; assert(sequence === undefined || sequence === source.version, 'OFFLINE_PINNED_MISMATCH'); return structuredClone(source); },
    independentRead: async (manifest: Manifest) => {
      const snapshot = structuredClone(memory.rows);
      if (options.childProcesses === false) return readCoverage(new OfflineMemory(snapshot), manifest);
      const dir = join(directory, 'readers', manifest.wave); mkdirSync(dir, { recursive: true, mode: 0o700 });
      // These are saved fixture rows, not a copied DB/probe or a new remote recall.
      const path = join(dir, 'public-input.json');
      writeFileSync(path, JSON.stringify({ manifest, snapshot }), { flag: 'wx', mode: 0o600 });
      const child = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../scripts/coverage-reader.ts', import.meta.url)), path], {
        cwd: dir, env: { NODE_NO_WARNINGS: '1', TZ: 'UTC' }, encoding: 'utf8', timeout: 20000, maxBuffer: 262144,
      });
      assert(!child.error && child.status === 0, 'COVERAGE_READER_PROCESS_FAILED');
      const result = JSON.parse(child.stdout);
      assert(result.processId === child.pid && result.processId !== process.pid, 'COVERAGE_READER_PROCESS_INVALID');
      processChecks.push({ wave: manifest.wave, pid: child.pid, parentPid: process.pid });
      return result;
    }, close: () => { closed++; } };
  return { ports, memory, processChecks, stats: () => ({ checkpointCalls, closed, ...memory.counts }) };
}
