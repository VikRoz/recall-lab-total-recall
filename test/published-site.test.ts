import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { articleHtml, buildPublishedSite } from '../scripts/build-published-site.ts';

test('published static build keeps the model evidence, includes approved article and verifies offline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-published-site-'));
  try {
    const data = await buildPublishedSite(dir);
    assert.deepEqual(data.totals, { A: 2, B: 3, C: 3, D: 3 });
    assert.equal(data.stages[2].arms[2].citationAudit.status, 'unverifiable');
    const html = readFileSync(join(dir, 'index.html'), 'utf8'), article = readFileSync(join(dir, 'blog.html'), 'utf8');
    assert.match(html, /href="\.\/blog.html"/); assert.ok(!html.includes('Не опубликовано<br>'));
    assert.ok(article.includes('The deterministic selector passed all three points too.'));
    assert.ok(article.includes('pass citation remains unverifiable'));
    assert.ok(!article.includes('Draft for publication'));
    assert.match(html, /<html lang="en">/);
    const ui = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>|<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    assert.ok(!/[\u0400-\u04ff]/.test(ui), 'All interface text and accessibility labels are English');
    assert.ok(html.includes('Showing ${count} of ${records.length} records'));
    const original = readFileSync(join(import.meta.dirname, '../evidence/scenario-probe-v1/live-report.json'));
    assert.deepEqual(readFileSync(join(dir, 'model-report.json')), original);
    for (const name of ['README.md', 'RUNBOOK.md']) assert.ok(!/[\u0400-\u04ff]/.test(readFileSync(join(dir, name), 'utf8')));
    const checks = JSON.parse(readFileSync(join(dir, 'CHECKSUMS.json'), 'utf8')); assert.equal(Object.keys(checks).length, 8);
    const result = spawnSync(process.execPath, [join(dir, 'verify.mjs')], { cwd: dir, env: {}, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).providerCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('static article escapes markup and wraps its comparison table without loading scripts', () => {
  const html = articleHtml('# Article\n\n<script>alert(1)</script>\n\n| A | B |\n| --- | --- |\n| fail | pass |');
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('class="table-scroll"')); assert.ok(html.includes('script-src \'none\''));
});
