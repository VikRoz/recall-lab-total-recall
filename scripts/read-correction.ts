// Run in a separate container with only this public manifest mounted, and no writer directory/SQLite.
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { Fault, assert } from '../src/domain.ts';
import { PLAN_HASH, validateManifest, verifyIndependentCorrection } from '../src/correction.ts';

try {
  assert(process.argv.length === 4 && process.argv[2] === '--manifest', 'CORRECTION_READER_ARGUMENTS_INVALID');
  assert(process.env.RECALL_CORRECTION_V1_READ_CONFIRMED === PLAN_HASH, 'CORRECTION_READ_NOT_AUTHORIZED');
  const path = process.argv[3], stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192, 'CORRECTION_MANIFEST_FILE_INVALID');
  const manifest = JSON.parse(readFileSync(path, 'utf8')); validateManifest(manifest);
  // The reader gets one attempt. This file lives in a dedicated empty output directory, not the writer volume.
  writeFileSync('reader-attempt.json', JSON.stringify({ planHash: PLAN_HASH, oneShot: true }), { flag: 'wx', mode: 0o600 });
  const { connectWalrus } = await import('../src/providers/walrus.ts');
  const memory = await connectWalrus(process.env);
  let inventories = 0, recalls = 0;
  const result = await verifyIndependentCorrection({ mode: 'live',
    inventory: () => { assert(++inventories <= 2, 'CORRECTION_READER_LIMIT'); return memory.inventory(); },
    recall: (q, n) => { assert(++recalls <= 1, 'CORRECTION_READER_LIMIT'); return memory.recall(q, n); },
    remember: async () => { throw new Fault('CORRECTION_READER_WRITE_FORBIDDEN'); },
    status: async () => { throw new Fault('CORRECTION_READER_STATUS_FORBIDDEN'); } }, manifest);
  writeFileSync('reader-result.json', JSON.stringify({ ...result, inventories, recalls }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'CORRECTION_READER_BLOCKED', code: error instanceof Fault ? error.code : 'CORRECTION_READER_FAILED',
    instruction: 'No recall retries, writer mount, new write or fabricated result.', additionalSpendLimitUSD: 0 })); process.exitCode = 2;
}
