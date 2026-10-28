import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/domain.ts';
import { CoverageLedger } from '../src/coverage-ledger.ts';
import { executeCoverage } from '../src/coverage-runner.ts';
import { BASE_EXPECTED, COVERAGE_PLAN_HASH, hash, LIMITS, readCoverage } from '../src/coverage-spec.ts';
import type { Manifest } from '../src/coverage-spec.ts';
import { adapterPorts } from '../src/coverage-adapters.ts';
import { adapterDryDriver } from '../src/coverage-adapter-dry.ts';
import { AdapterStubBackend, stubTatum } from '../src/coverage-adapter-stubs.ts';
import { authorizeRun, readerEnvironment, validateRunPermit } from '../src/coverage-authorization.ts';
import type { RunPermit } from '../src/coverage-authorization.ts';
import { requestCoverageReader } from '../src/coverage-reader-bridge.ts';
import { providerCommand } from '../scripts/coverage-providers.ts';
import { NAMESPACE, RELAYER, WalrusMemory } from '../src/providers/walrus.ts';
import { ENDPOINTS } from '../src/providers/tatum.ts';
const root = new URL('../', import.meta.url);
const input = () => JSON.parse(readFileSync(new URL('evidence/rehearsal-v1/input.json', root), 'utf8'));
const plan = () => JSON.parse(readFileSync(new URL('docs/mainnet-eight-plan-v1.json', root), 'utf8'));
function permit(): RunPermit {
  return { schema: 1, status: 'PREPARED_NOT_AUTHORIZED', planHash: COVERAGE_PLAN_HASH, network: 'mainnet', namespace: NAMESPACE,
    relayer: RELAYER, tatumEndpoint: ENDPOINTS.mainnet, accountIdHash: hash('0x' + 'a'.repeat(64)), sourceBundleHash: '1'.repeat(64),
    runtimeImageId: 'sha256:' + '2'.repeat(64), launcherSha256: '3'.repeat(64), limits: { ...LIMITS }, readerTimeoutMs: 60000, additionalSpendLimitUSD: 0 };
}
function environment(p = permit()): Record<string, string> {
  return { MEMWAL_ACCOUNT_ID: '0x' + 'a'.repeat(64), MEMWAL_KEY: 'OFFLINE_PUBLIC_SENTINEL', TATUM_API_KEY: 'OFFLINE_PUBLIC_SENTINEL',
    RECALL_COVERAGE_MAINNET_APPROVED_HASH: hash(p), RECALL_COVERAGE_ZERO_SPEND_CONFIRMED_HASH: hash(p),
    RECALL_FREE_TIER_CONFIRMED: 'true', RECALL_WALRUS_SPONSOR_CONFIRMED: 'true', RECALL_RUNTIME_IMAGE_ID: p.runtimeImageId };
}
function setup() {
  const i = input(), records = [i.stage0.record, i.correction.probe.record];
  return { i, backend: new AdapterStubBackend(BASE_EXPECTED.map(e => ({ blobId: e.blobId, text: canonical(records.find(r => r.id === e.id)) }))),
    tatum: stubTatum(i.correction.probe.source) };
}
test('pure default command and missing approval never create a connection or a live ledger', async () => {
  assert.equal((await providerCommand([], {})).status, 'PROVIDER_BINDING_PREPARED_NOT_EXECUTED');
  const p = permit(); assert.throws(() => adapterPorts({ mode: 'LIVE_MAINNET', permit: p, env: {}, clock: {} as any,
    independentRead: async () => { throw Error('unexpected'); }, factories: { memory: async () => { throw Error('connection'); }, tatum: async () => { throw Error('connection'); } } }), /NEW_APPROVAL_REQUIRED/);
  const dir = mkdtempSync(join(tmpdir(), 'binding-gates-'));
  try {
    const file = join(dir, 'permit.json'); writeFileSync(file, JSON.stringify(p));
    await assert.rejects(providerCommand(['--execute', '--permit', file, '--output', join(dir, 'new-state')], {}), /NEW_APPROVAL_REQUIRED/);
    assert.equal(existsSync(join(dir, 'new-state')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('approval binds exact permit, account, runtime, endpoints, caps and zero-spend confirmation', () => {
  const p = permit(), env = environment(p); authorizeRun(p, env, 'writer');
  for (const [key, value] of [['RECALL_COVERAGE_MAINNET_APPROVED_HASH', ''], ['RECALL_COVERAGE_ZERO_SPEND_CONFIRMED_HASH', ''],
    ['RECALL_FREE_TIER_CONFIRMED', 'false'], ['RECALL_WALRUS_SPONSOR_CONFIRMED', 'false'], ['MEMWAL_ACCOUNT_ID', '0x' + 'b'.repeat(64)],
    ['RECALL_RUNTIME_IMAGE_ID', 'sha256:' + '0'.repeat(64)], ['TATUM_API_KEY', '']]) assert.throws(() => authorizeRun(p, { ...env, [key]: value }, 'writer'));
  for (const change of [(r: any) => r.relayer = 'https://other.invalid', (r: any) => r.network = 'testnet',
    (r: any) => r.limits.remember = 9, (r: any) => r.extra = true]) { const r = structuredClone(p); change(r); assert.throws(() => validateRunPermit(r)); }
});
test('reader environment excludes Tatum/Cloudflare and requires the same exact permit', () => {
  const p = permit(), env = { ...environment(p), CLOUDFLARE_API_TOKEN: 'OFFLINE_SECRET_SENTINEL' };
  const selected = readerEnvironment(env);
  assert.equal(selected.TATUM_API_KEY, undefined); assert.equal(selected.CLOUDFLARE_API_TOKEN, undefined);
  authorizeRun(p, selected, 'reader'); assert.throws(() => authorizeRun(p, env, 'reader'), /EXCESS_CREDENTIALS/);
});
test('actual adapters with stub clients complete both waves and two fresh reader processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'binding-dry-')), ledger = new CoverageLedger(join(dir, 'coverage-offline.sqlite'));
  try {
    const d = adapterDryDriver(input(), dir); assert.equal(d.stats().memoryConnections, 0);
    const r = await executeCoverage(plan(), ledger, d.ports);
    assert.equal(r.status, 'ADAPTER_DRY_RUN_COMPLETED'); assert.equal(r.providerApiCalls, 0); assert.equal(r.mainnetWrites, 0);
    assert.equal(d.stats().memoryConnections, 1); assert.equal(d.stats().tatumConnections, 1); assert.equal(d.stats().closedTatum, 1);
    assert.equal(d.tatum.requests[0].checkpointId.oneofKind, undefined);
    assert.equal(d.tatum.requests[1].checkpointId.sequenceNumber, input().correction.probe.source.version);
    assert.equal(d.readers.length, 2); assert.ok(d.readers.every((r: any) => r.pid !== process.pid));
    assert.deepEqual(d.readers.map((r: any) => r.stubClientCalls.list), [4, 6]);
    assert.deepEqual([...d.backend.jobs.values()].map(j => j.key), [3, 5, 7, 9, 4, 6, 8, 10].map(n => 'coverage:v1:memory:' + String(n).padStart(2, '0')));
    const before = d.stats(); await executeCoverage(plan(), ledger, d.ports); assert.deepEqual(d.stats(), before);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('live orchestration gate is exercised only with fake factories; reservations precede lazy connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'binding-live-mock-')), ledger = new CoverageLedger(join(dir, 'coverage-mainnet.sqlite'));
  try {
    const { i, backend, tatum } = setup(), p = permit(), env = environment(p); let mc = 0, tc = 0;
    let now = Date.parse(i.correction.probe.source.asOf) + 1000;
    const ports = adapterPorts({ mode: 'LIVE_MAINNET', permit: p, env, clock: { now: () => new Date(now).toISOString(), sleep: async ms => { now += ms; } },
      factories: { memory: async () => { mc++; assert.equal(ledger.count('inventory'), 2); assert.equal(ledger.count('recall'), 1); return backend.adapter(); },
        tatum: async () => { tc++; assert.equal(ledger.count('tatum'), 1); return tatum.adapter; } },
      independentRead: async m => { authorizeRun(p, readerEnvironment(env), 'reader'); return readCoverage(backend.adapter(), m); } });
    assert.deepEqual([mc, tc], [0, 0]);
    const result = await executeCoverage(plan(), ledger, ports);
    // This assertion is a mocked branch test, not an actual Mainnet receipt.
    assert.equal(result.status, 'COVERAGE_MAINNET_COMPLETED'); assert.equal(result.providerApiCalls, null);
    assert.deepEqual([mc, tc], [1, 1]); assert.equal(tatum.closed(), 1);
    await executeCoverage(plan(), ledger, ports); assert.deepEqual([mc, tc], [1, 1]);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('offline ledger cannot be promoted to live; dry mode cannot use default real factories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'binding-mode-')), ledger = new CoverageLedger(join(dir, 'coverage-offline.sqlite'));
  try {
    assert.throws(() => adapterPorts({ mode: 'ADAPTER_DRY_RUN', clock: {} as any, independentRead: async () => null as any }), /DRY_CLIENTS_REQUIRED/);
    const { backend, tatum } = setup(); let calls = 0;
    const ports = adapterPorts({ mode: 'LIVE_MAINNET', permit: permit(), env: environment(), clock: {} as any,
      independentRead: async () => null as any, factories: { memory: async () => { calls++; return backend.adapter(); }, tatum: async () => tatum.adapter } });
    await assert.rejects(executeCoverage(plan(), ledger, ports), /LIVE_AUTHORIZATION_REQUIRED/); assert.equal(calls, 0);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('failed lazy connector is sticky and never connects Tatum or retries', async () => {
  let connections = 0;
  const ports = adapterPorts({ mode: 'ADAPTER_DRY_RUN', clock: {} as any, independentRead: async () => null as any,
    factories: { memory: async () => { connections++; throw Error('OFFLINE_PRIVATE_ERROR'); }, tatum: async () => { throw Error('unexpected'); } } });
  await assert.rejects(ports.memory.inventory()); await assert.rejects(ports.memory.inventory()); assert.equal(connections, 1);
});
test('real Walrus adapter maps all status classes and enforces eight inventory pages', async () => {
  for (const [status, state] of [['running', 'pending'], ['uploaded', 'pending'], ['pending', 'pending'], ['not_found', 'unknown'], ['alien', 'unknown'], ['failed', 'failed'], ['done', 'done']]) {
    const port = new WalrusMemory({ getRememberStatus: async () => ({ status, blob_id: 'stub-blob' }) });
    assert.equal((await port.status('stub-job')).state, state);
  }
  let pages = 0;
  const port = new WalrusMemory({ listMemories: async () => ({ memories: [], snapshot_version: '1', must_resync: false, has_more: true, next_cursor: String(++pages) }) });
  await assert.rejects(port.inventory(), /PAGINATION_LIMIT/); assert.equal(pages, 8);
});
test('real adapter status exception stops before another remember and releases Tatum', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'binding-status-')), ledger = new CoverageLedger(join(dir, 'coverage-offline.sqlite'));
  try {
    const { i, backend, tatum } = setup(), client = backend.client(); client.getRememberStatus = async () => { throw Error('quota/access/timeout'); };
    let now = Date.parse(i.correction.probe.source.asOf) + 1000;
    const ports = adapterPorts({ mode: 'ADAPTER_DRY_RUN', clock: { now: () => new Date(now).toISOString(), sleep: async ms => { now += ms; } },
      factories: { memory: async () => new WalrusMemory(client), tatum: async () => tatum.adapter }, independentRead: async () => null as any });
    await assert.rejects(executeCoverage(plan(), ledger, ports), /STATUS_READ_UNKNOWN/);
    assert.equal(backend.counts.remember, 1); assert.equal(ledger.outbox(3).state, 'ACCEPTED'); assert.equal(tatum.closed(), 1);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('reader IPC atomically exchanges public requests, rejects failed/same-wave repeats and has a timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'binding-ipc-')), p = permit();
  const m: Manifest = { mode: 'LIVE_MAINNET', planHash: COVERAGE_PLAN_HASH, runPermitHash: hash(p), wave: 'A',
    entries: [...BASE_EXPECTED, ...[3, 5, 7, 9].map(n => ({ id: 'experience:coverage-v1:' + String(n).padStart(2, '0'), blobId: 'stub-' + n, hash: 'a'.repeat(64) }))] };
  try {
    let accepted = false;
    const waiting = requestCoverageReader(dir, m, p).then(r => { accepted = true; return r; }), request = join(dir, 'A/request.json');
    while (!existsSync(request)) await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(readFileSync(request, 'utf8')).manifest.runPermitHash, hash(p));
    mkdirSync(join(dir, 'A/output')); writeFileSync(join(dir, 'A/output/response.tmp'), '{"test":"public reply"}');
    renameSync(join(dir, 'A/output/response.tmp'), join(dir, 'A/output/response.json'));
    await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(accepted, false);
    writeFileSync(join(dir, 'A/completed'), 'READER_EXIT_ZERO');
    assert.deepEqual(await waiting, { test: 'public reply' });
    await assert.rejects(requestCoverageReader(dir, m, p));
    const failureDir = join(dir, 'failure'); const bad = requestCoverageReader(failureDir, m, p);
    while (!existsSync(join(failureDir, 'A/request.json'))) await new Promise(resolve => setImmediate(resolve));
    writeFileSync(join(failureDir, 'A/failed'), 'READER_FAILED'); await assert.rejects(bad, /SUPERVISOR_FAILED/);
    // Wall clock jump deterministically tests the fixed deadline without a 65s wait.
    const original = Date.now; let call = 0; Date.now = () => ++call === 1 ? 0 : 65001;
    try { await assert.rejects(requestCoverageReader(join(dir, 'timeout'), m, p), /SUPERVISOR_TIMEOUT/); }
    finally { Date.now = original; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
