// Two named local IPC requests; host supervisor runs isolated reader containers. No Docker socket in writer.
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, Fault } from './domain.ts';
import { hash, validateManifest } from './coverage-spec.ts';
import type { Manifest } from './coverage-spec.ts';
import { validateRunPermit } from './coverage-authorization.ts';
import type { RunPermit } from './coverage-authorization.ts';
export async function requestCoverageReader(root: string, manifest: Manifest, permit: RunPermit) {
  validateManifest(manifest); validateRunPermit(permit);
  assert(manifest.mode === 'LIVE_MAINNET' && manifest.runPermitHash === hash(permit)
    && ['A', 'B'].includes(manifest.wave), 'COVERAGE_READER_REQUEST_INVALID');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, manifest.wave); mkdirSync(dir, { mode: 0o700 });
  const tmp = join(dir, 'request.tmp'); writeFileSync(tmp, JSON.stringify({ manifest, permit }), { flag: 'wx', mode: 0o600 });
  renameSync(tmp, join(dir, 'request.json'));
  const started = Date.now();
  while (Date.now() - started < permit.readerTimeoutMs + 5000) {
    if (existsSync(join(dir, 'failed'))) throw new Fault('COVERAGE_READER_SUPERVISOR_FAILED');
    const response = join(dir, 'output', 'response.json');
    // A response alone is insufficient: the container might fail before successful exit.
    if (existsSync(join(dir, 'completed'))) {
      assert(existsSync(response), 'COVERAGE_READER_RESPONSE_MISSING');
      const stat = lstatSync(response); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 262144, 'COVERAGE_READER_RESPONSE_INVALID');
      return JSON.parse(readFileSync(response, 'utf8'));
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Fault('COVERAGE_READER_SUPERVISOR_TIMEOUT');
}
