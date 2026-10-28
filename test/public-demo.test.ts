import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { buildPublicDemo } from '../scripts/build-public-demo.ts';
import { publicDemoData } from '../src/public-demo.ts';
import { publicDemoHtml } from '../src/public-demo-view.ts';

const base = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, base), 'utf8');
const json = (p: string) => JSON.parse(read(p));
const css = read('public-demo/style.css'), client = read('public-demo/client.js');

test('public demo builds twice without credentials/network, preserves all evidence and produces stable HTML', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-public-demo-test-'));
  try {
    const data = await buildPublicDemo(join(dir, 'one'));
    await buildPublicDemo(join(dir, 'two'));
    assert.deepEqual(data.totals, { A: 2, B: 3, C: 3, D: 3 });
    assert.equal(data.records.length, 10); assert.equal(data.chains.length, 5);
    assert.equal(data.records.filter((r: any) => r.record.evidence.source === 'fixture').length, 2);
    assert.equal(data.stages[0].arms[2].citationAudit.status, 'supported');
    assert.equal(data.stages[2].arms[2].citationAudit.status, 'unverifiable');
    assert.equal(data.stages[0].arms[0].rawVerifier.status, 'fail');
    assert.equal(data.providerCallsThisBuild, 0);
    for (const name of ['index.html', 'demo-data.json', 'model-report.json', 'verification.json']) {
      assert.equal(readFileSync(join(dir, 'one', name), 'utf8'), readFileSync(join(dir, 'two', name), 'utf8'));
    }
    const changed = json('evidence/scenario-probe-v1/live-report.json');
    changed.rows[0].arms[0].goalCompleted = true;
    assert.throws(() => publicDemoData({}, {}, {}, json('deploy/scenario-probe-run-v1.json'), changed), /PUBLIC_DEMO_MODEL_EVIDENCE_CHANGED/);
    const missingReceipt = structuredClone(data.records); missingReceipt[0].receipt = null;
    assert.throws(() => publicDemoData({ status: 'UNIFIED_TEN_RECORD_REHEARSAL_VERIFIED',
      independentProcess: { checked: true, recordsVerified: 10, credentialEnvironment: 'NONE', remoteRecallThisRun: false },
      coverage: { records: missingReceipt } }, json('evidence/scenario-probe-v1/prepared-report.json'),
    json('evidence/scenario-probe-v1/prepared-scenario.json'), json('deploy/scenario-probe-run-v1.json'),
    json('evidence/scenario-probe-v1/live-report.json')), /PUBLIC_DEMO_RECEIPTS_MISSING/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('standalone HTML escapes hostile evidence, binds inline CSP and declares all uncertainty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-public-view-test-'));
  try {
    const data = await buildPublicDemo(dir);
    data.stages[0].rawResponses.A = '</script><img src=x onerror=alert(1)>';
    data.records[0].id = '<svg onload=alert(1)>';
    const html = publicDemoHtml(data, css, client);
    assert.ok(!html.includes('<img src=x')); assert.ok(!html.includes('<svg onload='));
    assert.ok(html.includes('&lt;/script&gt;&lt;img'));
    assert.ok(html.includes('\\u003c/script\\u003e'));
    assert.ok(html.includes("connect-src &#39;none&#39;"));
    assert.ok(!/\son\w+="/i.test(html));
    assert.ok(!/\b(?:href|src)="(?:https?:|\/\/)/i.test(html));
    for (const body of [css, client]) {
      const digest = createHash('sha256').update(body).digest('base64');
      assert.ok(html.includes(`sha256-${digest}`));
    }
    assert.ok(html.includes('Преимущество LLM над алгоритмом не доказано'));
    assert.ok(html.includes('Ссылка непроверяема'));
    assert.ok(html.includes('СОХРАНЁННЫЕ ДАННЫЕ · REPLAY'));
    assert.ok(html.includes('Прежние отрицательные пилоты сохранены'));
    assert.equal((html.match(/data-record data-kind=/g) ?? []).length, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('actual presentation controls switch stages, filter correction/synthetic records and recover from empty search', () => {
  // Small DOM port runs the shipped browser script; this is interaction logic QA, not browser/layout QA.
  function element(dataset: any = {}) {
    return { dataset, hidden: false, value: '', textContent: '', attributes: {} as Record<string, string>,
      events: {} as Record<string, () => void>, setAttribute(k: string, v: string) { this.attributes[k] = v; },
      addEventListener(k: string, f: () => void) { this.events[k] = f; } };
  }
  const source = json('evidence/coverage-mainnet-v1/live-evidence.json').readers.find((r: any) => r.wave === 'B').result.records;
  const buttons = [element(), element(), element()], panels = [element(), element(), element()];
  const records = source.map((r: any) => element({ kind: r.supersedes ? 'correction' : 'observation',
    source: r.evidence.source, search: [r.id, r.serviceId, r.family, r.verdict, r.supersedes ?? ''].join(' ').toLowerCase() }));
  const ids: any = Object.fromEntries(['memory-search', 'memory-filter', 'record-count', 'empty-records', 'download-data'].map(x => [x, element()]));
  ids['memory-filter'].value = 'all';
  runInNewContext(client, { document: { querySelectorAll: (s: string) => s === '[data-stage]' ? buttons : s === '.stage-panel' ? panels : records,
    getElementById: (id: string) => ids[id] } });
  assert.deepEqual(panels.map(p => p.hidden), [false, true, true]);
  buttons[2].events.click(); assert.deepEqual(panels.map(p => p.hidden), [true, true, false]);
  ids['memory-filter'].value = 'correction'; ids['memory-filter'].events.change();
  assert.equal(records.filter((r: any) => !r.hidden).length, 5);
  ids['memory-filter'].value = 'fixture'; ids['memory-filter'].events.change();
  assert.equal(records.filter((r: any) => !r.hidden).length, 2);
  ids['memory-search'].value = 'no-such-record'; ids['memory-search'].events.input();
  assert.equal(records.filter((r: any) => !r.hidden).length, 0); assert.equal(ids['empty-records'].hidden, false);
  ids['memory-search'].value = ''; ids['memory-filter'].value = 'all'; ids['memory-search'].events.input();
  assert.equal(records.filter((r: any) => !r.hidden).length, 10); assert.equal(ids['empty-records'].hidden, true);
});

test('portable package verifies in an empty credential environment and refuses a changed shipped file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-public-package-test-'));
  try {
    await buildPublicDemo(dir);
    const run = () => spawnSync(process.execPath, [join(dir, 'verify.mjs')], { cwd: dir, env: {}, encoding: 'utf8', timeout: 10000 });
    const clean = run(); assert.equal(clean.status, 0); assert.equal(JSON.parse(clean.stdout).providerCalls, 0);
    appendFileSync(join(dir, 'index.html'), '\nchanged');
    const tampered = run(); assert.equal(tampered.status, 1); assert.match(tampered.stderr, /PACKAGE_VERIFICATION_FAILED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
