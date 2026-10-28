import { assert } from './domain.ts';
import type { Snapshot } from './domain.ts';
import type { MemoryPort } from './memory.ts';
import type { Clock, Manifest } from './coverage-spec.ts';
import { hash } from './coverage-spec.ts';
import type { CoveragePorts } from './coverage-runner.ts';
import { authorizeRun } from './coverage-authorization.ts';
import type { RunPermit } from './coverage-authorization.ts';
type TatumPort = { checkpoint(sequence?: string): Promise<Snapshot>; close(): void };
export type AdapterFactories = { tatum(env: Record<string, string | undefined>): Promise<TatumPort>;
  memory(env: Record<string, string | undefined>): Promise<MemoryPort> };
const realFactories: AdapterFactories = {
  tatum: async env => (await import('./providers/tatum.ts')).connectTatum(env, 'mainnet'),
  memory: async env => (await import('./providers/walrus.ts')).connectWalrus(env),
};
export function adapterPorts(options: {
  mode: 'ADAPTER_DRY_RUN' | 'LIVE_MAINNET'; clock: Clock;
  independentRead: CoveragePorts['independentRead']; factories?: AdapterFactories;
  permit?: RunPermit; env?: Record<string, string | undefined>;
}): CoveragePorts {
  const live = options.mode === 'LIVE_MAINNET';
  const env = { ...(options.env ?? {}) }, permit = options.permit ? structuredClone(options.permit) : undefined;
  if (live) authorizeRun(permit, env, 'writer');
  else assert(options.factories && !permit && Object.keys(env).length === 0, 'COVERAGE_DRY_CLIENTS_REQUIRED');
  const factories = options.factories ?? realFactories;
  let memoryPromise: Promise<MemoryPort> | undefined, tatumPromise: Promise<TatumPort> | undefined;
  let resolvedTatum: TatumPort | undefined, closed = false;
  const memory = () => memoryPromise ??= Promise.resolve().then(() => factories.memory(env)).then(port => {
    assert(port.mode === 'live', 'COVERAGE_REAL_ADAPTER_REQUIRED'); return port;
  });
  const tatum = () => tatumPromise ??= Promise.resolve().then(() => factories.tatum(env)).then(port => {
    resolvedTatum = port; if (closed) port.close(); return port;
  });
  // Construction and authorize() are pure. Connections only occur behind engine reservations.
  return { mode: options.mode, ...(live ? { runPermitHash: hash(permit), authorize: () => { authorizeRun(permit, env, 'writer'); } } : {}),
    memory: { mode: 'live', inventory: async () => (await memory()).inventory(), recall: async (q, n) => (await memory()).recall(q, n),
      remember: async (text, key) => (await memory()).remember(text, key), status: async job => (await memory()).status(job) },
    checkpoint: async sequence => (await tatum()).checkpoint(sequence), clock: options.clock, independentRead: options.independentRead,
    close: () => { if (!closed) { closed = true; resolvedTatum?.close(); } } };
}
