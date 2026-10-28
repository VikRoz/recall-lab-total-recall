import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/http.ts';
import { spawnSync } from 'node:child_process';

test('public preview exposes labelled fixture output and blocks live/mutation endpoints', async () => {
  const page = await handle(new Request('http://localhost/'));
  assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /Stage 0 · Offline fixture/);
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
  const parsed = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const fixture = await handle(new Request('http://localhost/api/fixture/demo'));
  const body = await fixture.json() as any;
  assert.equal(body.mode, 'DETERMINISTIC_FIXTURE'); assert.equal(body.mainnetWrites, 0);
  assert.equal((await handle(new Request('http://localhost/api/live', { method: 'POST' }))).status, 405);
  assert.equal((await handle(new Request('http://localhost/api/live'))).status, 404);
  const status = await (await handle(new Request('http://localhost/api/readiness'))).json() as any;
  assert.equal(status.status, 'BLOCKED');
});
