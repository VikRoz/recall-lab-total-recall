import { mkdirSync } from 'node:fs';
import { Journal } from '../src/local-journal.ts';
import { connectTatum } from '../src/providers/tatum.ts';
import { connectModel, MODEL_ID } from '../src/providers/model.ts';
import { connectWalrus } from '../src/providers/walrus.ts';
import { completeMemory } from '../src/memory.ts';
import { cycle, observation } from '../src/agent.ts';
import { assert, experience, Fault } from '../src/domain.ts';
import type { Offer, Task } from '../src/domain.ts';
import { diagnose } from './doctor.ts';

let journal: Journal | undefined;
let tatumConnection: Awaited<ReturnType<typeof connectTatum>> | undefined;
try {
  assert(process.env.RECALL_FREE_TIER_CONFIRMED === 'true', 'FREE_TIER_NOT_CONFIRMED');
  assert(process.env.RECALL_WALRUS_SPONSOR_CONFIRMED === 'true', 'WALRUS_SPONSOR_NOT_CONFIRMED');
  assert(!diagnose().checks.some(x => ['MISSING_CREDENTIAL', 'MISSING_DEPENDENCY', 'RUNTIME_UPGRADE_REQUIRED'].includes(x.status)), 'SETUP_INCOMPLETE');
  // Run doctor and resolve every dependency/runtime gate before this command.
  const tatum = await connectTatum(process.env);
  tatumConnection = tatum;
  const memory = await connectWalrus(process.env);
  const model = connectModel(process.env);
  mkdirSync('.local', { recursive: true, mode: 0o700 });
  journal = new Journal('.local/stage0.sqlite');
  const j = journal;
  // Fixed operation IDs make a rerun resume the same smoke test instead of spending again.
  const source = await j.once('stage0:tatum:source', 'tatum', { operation: 'latest-checkpoint', network: 'mainnet' }, () => tatum.checkpoint());
  const t: Task = { id: 'stage0-smoke', network: 'mainnet', family: 'checkpoint', target: source.target,
    requiredFields: ['digest', 'sequenceNumber'], maxAgeMs: 600000, budget: '3', cutoff: source.asOf };
  const catalog: Offer[] = ['atlas', 'beacon', 'cipher'].map((id, i) => ({ id, version: 'v1', network: 'mainnet',
    families: ['checkpoint'], fields: ['digest', 'sequenceNumber'], price: String(i + 1) }));
  const output = await cycle(t, catalog, {
    memory,
    model: { mode: 'live', select: context => j.once('stage0:model:select', 'model', { modelId: MODEL_ID, context }, () => model.select(context)) },
    service: async offer => {
      const projected = structuredClone(source);
      // A controlled projection of genuine Tatum data, not an external merchant.
      if (offer.id === 'atlas') delete projected.fields.digest;
      return { ...projected, serviceId: offer.id, serviceVersion: offer.version };
    },
    reference: async result => j.once('stage0:tatum:verify', 'tatum', { sequence: result.version }, () => tatum.checkpoint(result.version)),
  }, false);
  assert(output.status === 'VERIFIED', 'SMOKE_MODEL_DECLINED');
  const previous = j.outbox('stage0:experience:1');
  const record = previous ? experience(JSON.parse(previous.payload)) : observation(t, output, new Date().toISOString());
  j.plan('stage0:experience:1', record);
  // One status read per invocation. Pending is resumable and never counts as done.
  const receipt = await j.advance('stage0:experience:1', memory);
  if (receipt.state !== 'done') {
    console.log(JSON.stringify({ status: 'MEMORY_PENDING', receipt, instruction: 'Rerun this same command to check the accepted job. Do not change operation IDs.' }));
    process.exitCode = 2;
  } else {
    const returned = await completeMemory(memory, [receipt.blobId!]);
    assert(returned.some(x => x.id === record.id), 'SMOKE_RECALL_INCOMPLETE');
    console.log(JSON.stringify({ status: 'LOCAL_LIVE_SMOKE_PASSED', receipt, verification: output.verification,
      nextGate: 'Run the separate memory:read client, then repeat the integration on the target Worker. CPU, D1 and model quality remain unverified.' }, null, 2));
  }
} catch (e) {
  console.log(JSON.stringify({ status: 'BLOCKED', code: e instanceof Fault ? e.code : 'LIVE_SMOKE_FAILED', additionalSpendLimitUSD: 0 }));
  process.exitCode = 2;
} finally { journal?.close(); tatumConnection?.close(); }
