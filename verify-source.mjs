import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('.', import.meta.url));
try {
  const manifest = JSON.parse(readFileSync(join(root, 'SOURCE_MANIFEST.json'), 'utf8'));
  function files(dir) {
    return readdirSync(dir).filter(name => !['.git', 'node_modules', '.local', '.DS_Store'].includes(name) && (name === '.env.example' || !name.startsWith('.env'))).flatMap(name => {
      const path = join(dir, name), stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), 'Unexpected symlink');
      return stat.isDirectory() ? files(path) : [relative(root, path)];
    });
  }
  const actual = files(root).filter(name => name !== 'SOURCE_MANIFEST.json').sort();
  assert.deepEqual(actual, Object.keys(manifest.files).sort());
  for (const name of actual) {
    assert(!name.includes('..') && !name.startsWith('/') && !name.includes('\\'));
    assert.equal(createHash('sha256').update(readFileSync(join(root, name))).digest('hex'), manifest.files[name], name);
  }
  console.log(JSON.stringify({ status: 'PUBLIC_SOURCE_SNAPSHOT_VERIFIED', files: actual.length,
    providerCalls: 0, remoteRepositoryPublication: 'NOT_ATTESTED_BY_OFFLINE_CHECK' }, null, 2));
} catch {
  console.error('SOURCE_VERIFICATION_FAILED'); process.exitCode = 1;
}
