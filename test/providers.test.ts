import test from 'node:test';
import assert from 'node:assert/strict';
import { WalrusMemory, NAMESPACE } from '../src/providers/walrus.ts';
import { TatumData, ENDPOINTS, connectTatum } from '../src/providers/tatum.ts';
import { CloudflareModel, modelRequest } from '../src/providers/model.ts';
import { offers, task } from '../src/fixtures.ts';
import { diagnose } from '../scripts/doctor.ts';

test('inventory follows has_more even when a namespace-filtered page is empty', async () => {
  const calls: any[] = [];
  const memory = new WalrusMemory({ listMemories: async (options: unknown) => {
    calls.push(options);
    return calls.length === 1 ? { memories: [], snapshot_version: 7, must_resync: false, has_more: true, next_cursor: 'next' }
      : { memories: [{ namespace_id: NAMESPACE, blob_id: 'blob', expires_at: null }], snapshot_version: 7, must_resync: false, has_more: false };
  } });
  assert.deepEqual(await memory.inventory(), { blobIds: ['blob'], revision: '7' });
  assert.equal(calls[1].cursor, 'next');
});
test('Walrus submission passes the durable explicit operation key', async () => {
  let received: unknown[] = [];
  const memory = new WalrusMemory({ remember: async (...args: unknown[]) => { received = args; return { job_id: 'job-1' }; } });
  assert.deepEqual(await memory.remember('public content', 'event:fixed'), { jobId: 'job-1' });
  assert.deepEqual(received, ['public content', NAMESPACE, { idempotencyKey: 'event:fixed' }]);
});
test('Tatum adapter requests a pinned checkpoint and exposes only requested evidence', async () => {
  let received: any;
  const data = new TatumData({ ledgerService: { getCheckpoint: async (request: unknown) => {
    received = request;
    return { response: { checkpoint: { sequenceNumber: '42', digest: 'abc', summary: { timestamp: { seconds: '1792843200', nanos: 0 } } } } };
  } } }, 'mainnet');
  const r = await data.checkpoint('42');
  assert.equal(received.checkpointId.sequenceNumber, '42');
  assert.equal(r.version, '42'); assert.equal(r.source, 'tatum');
  assert.equal(received.readMask.paths.includes('summary.timestamp'), true);
});
test('Tatum latest request carries the explicit unset protobuf oneof', async () => {
  let received: any;
  const data = new TatumData({ ledgerService: { getCheckpoint: async (request: unknown) => {
    received = request;
    return { response: { checkpoint: { sequenceNumber: '43', digest: 'latest', summary: { timestamp: { seconds: '1792843200', nanos: 0 } } } } };
  } } }, 'testnet');
  const result = await data.checkpoint();
  assert.deepEqual(received.checkpointId, { oneofKind: undefined });
  assert.equal(result.version, '43');
  assert.equal(result.network, 'testnet');
});
test('installed Sui SDK serializes latest and pinned Tatum requests without network', async (t) => {
  const packageName = '@mysten/sui/grpc';
  let sdk: any;
  try { sdk = await import(packageName); }
  catch (error: any) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('Sui SDK is absent in the offline workspace');
    return;
  }
  const client = new sdk.SuiGrpcClient({ network: 'testnet', baseUrl: ENDPOINTS.testnet });
  const method = client.ledgerService.methods.find((item: any) => item.localName === 'getCheckpoint');
  assert.ok(method, 'SDK checkpoint method descriptor is available');
  let calls = 0;
  const data = new TatumData({ ledgerService: { getCheckpoint: async (request: any) => {
    const encoded = method.I.toBinary(request);
    assert.ok(encoded instanceof Uint8Array);
    calls++;
    const response = method.O.fromBinary(method.O.toBinary(method.O.fromJson({
      checkpoint: { sequenceNumber: '42', digest: 'abc', summary: { timestamp: '2026-10-24T12:00:00Z' } },
    })));
    assert.equal(typeof response.checkpoint.sequenceNumber, 'bigint');
    return { response };
  } } }, 'testnet');
  assert.equal((await data.checkpoint()).version, '42');
  assert.equal((await data.checkpoint('42')).version, '42');
  assert.equal(calls, 2);
});
test('Tatum bigint checkpoints preserve precision and compare pinned IDs as strings', async () => {
  const sequence = '9007199254740993';
  const data = new TatumData({ ledgerService: { getCheckpoint: async () => ({ response: {
    checkpoint: { sequenceNumber: BigInt(sequence), digest: 'abc', summary: { timestamp: { seconds: 1792843200n, nanos: 0 } } },
  } }) } }, 'testnet');
  const result = await data.checkpoint(sequence);
  assert.equal(result.version, sequence);
  assert.equal(result.target, 'checkpoint:' + sequence);
  assert.equal(result.fields.sequenceNumber, sequence);
  assert.equal(result.asOf, '2026-10-24T12:00:00.000Z');
  assert.doesNotThrow(() => JSON.stringify(result));
  await assert.rejects(data.checkpoint('9007199254740992'), /TATUM_CHECKPOINT_MISMATCH/);
});
test('Tatum checkpoint normalization rejects missing, numeric and malformed sequence IDs', async () => {
  for (const sequenceNumber of [undefined, 42, -1n, '', '01', 'invalid']) {
    const data = new TatumData({ ledgerService: { getCheckpoint: async () => ({ response: {
      checkpoint: { sequenceNumber, digest: 'abc', summary: { timestamp: { seconds: 1792843200n, nanos: 0 } } },
    } }) } }, 'testnet');
    await assert.rejects(data.checkpoint(), /TATUM_RESPONSE_INVALID/);
  }
});
test('model errors never cause a hidden repair call', async () => {
  let calls = 0;
  const model = new CloudflareModel(async () => { calls++; return { response: 'invalid JSON' }; });
  assert.equal(await model.select({ task: task('model'), offers, memories: [] }), 'invalid JSON');
  assert.equal(calls, 1);
  assert.equal(modelRequest({ task: task('model'), offers, memories: [] }).max_tokens, 512);
});
test('Tatum channel cleanup runs only once', () => {
  let closed = 0;
  const data = new TatumData({}, 'testnet', () => { closed++; });
  data.close(); data.close();
  assert.equal(closed, 1);
});
test('installed native transport constructs the Tatum client without a network call', async (t) => {
  for (const packageName of ['@mysten/sui/grpc', '@protobuf-ts/grpc-transport', '@grpc/grpc-js']) {
    try { await import(packageName); }
    catch (error: any) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      t.skip('Native SDK dependencies are absent in the offline workspace');
      return;
    }
  }
  const data = await connectTatum({ TATUM_API_KEY: 'public-test-sentinel' }, 'testnet');
  try {
    assert.equal(data.network, 'testnet');
    assert.equal(typeof data.client.ledgerService.getCheckpoint, 'function');
  } finally { data.close(); }
});
test('doctor reports gates without exposing credentials or calling a provider', () => {
  const r = diagnose({ MEMWAL_KEY: 'sensitive-sentinel' });
  assert.equal(r.status, 'BLOCKED'); assert.equal(r.networkCalls, 0);
  assert.equal(JSON.stringify(r).includes('sensitive-sentinel'), false);
  assert.equal(r.liveGates.mainnetWrite, 'NOT_RUN');
});
