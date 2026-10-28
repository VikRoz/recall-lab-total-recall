// Separate read-only client. It has no access to the local journal or previous chat.
import { connectWalrus } from '../src/providers/walrus.ts';
import { completeMemory } from '../src/memory.ts';
import { Fault } from '../src/domain.ts';

try {
  const memory = await connectWalrus(process.env);
  const flag = process.argv.indexOf('--expect-blob');
  const expected = flag >= 0 ? [process.argv[flag + 1]] : [];
  if (expected.some(x => !x)) throw new Fault('EXPECTED_BLOB_ARGUMENT_MISSING');
  const records = await completeMemory(memory, expected);
  console.log(JSON.stringify({ mode: 'LIVE_WALRUS_MAINNET', status: expected.length ? 'EXPECTED_BLOB_READ' : 'INSPECTION_ONLY', namespaceRecords: records.length, records }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ status: 'BLOCKED', code: e instanceof Fault ? e.code : 'MEMORY_READ_FAILED' }));
  process.exitCode = 2;
}
