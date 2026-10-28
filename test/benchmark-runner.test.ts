import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildEvaluationPlan } from '../src/evaluation-plan.ts';
import { hash } from '../src/evaluation.ts';
import { canonical } from '../src/domain.ts';
import { Journal } from '../src/local-journal.ts';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'recall-benchmark-test-')), plan = await buildEvaluationPlan();
  const files = ['pilot-v1/freeze.json', 'pilot-v1/report.json', 'pilot-v2/report.json',
    'pilot-70b/report.json', 'pilot-70b.stdout.json', 'pilot-70b-envelope.stdout.json'];
  for (const name of [...files, 'benchmark-v1/plan.json']) {
    const path = join(directory, '.local/evaluation', name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, name.endsWith('/plan.json') ? canonical(plan) : '{"synthetic-test-fixture":true}');
  }
  const j = new Journal(join(directory, '.local/stage0.sqlite')); j.close();
  const run = (quota: boolean) => {
    const runner = new URL('../scripts/evaluate-benchmark.ts', import.meta.url).href;
    const harness = `import {writeFileSync} from 'node:fs';
      let calls=0; globalThis.fetch=async (_url, options)=>{
        calls++; const body=JSON.parse(options.body);
        if(body.max_tokens!==512||body.temperature!==0) throw Error('limits');
        if(${quota}) return new Response('',{status:429});
        return new Response(JSON.stringify({success:true,result:{response:calls===1?'{broken':JSON.stringify({serviceId:null,reason:'fixture abstention',memoryIds:[]})}}));
      };
      try {await import(${JSON.stringify(runner)});} finally {writeFileSync('fetch-count.json',String(calls));}`;
    return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', harness], {
      cwd: directory, env: { PATH: process.env.PATH, RECALL_EVAL_BENCHMARK_CONFIRMED: 'true', RECALL_FREE_TIER_CONFIRMED: 'true',
        RECALL_BENCHMARK_PLAN_HASH: hash(plan), CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'public-test-sentinel' },
      encoding: 'utf8', maxBuffer: 1048576,
    });
  };
  return { directory, plan, files, run };
}
test('the complete runner scores malformed output and finishes all arms within the frozen request cap without network', async () => {
  const f = await fixture();
  try {
    const result = f.run(false); assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(join(f.directory, '.local/evaluation/benchmark-v1/report.json'), 'utf8'));
    assert.equal(report.status, 'BENCHMARK_COMPLETED'); assert.equal(report.modelCallsThisInvocation, 26);
    assert.equal(report.rows.length, 32); assert.ok(report.rows.some((r: any) => r.verdict === 'error'));
    assert.equal(report.tatumCalls, 0); assert.equal(report.walrusOperations, 0);
    assert.equal(Number(readFileSync(join(f.directory, 'fetch-count.json'), 'utf8')), 26);
    for (const name of f.files) assert.equal(readFileSync(join(f.directory, '.local/evaluation', name), 'utf8'), '{"synthetic-test-fixture":true}');
    const j = new Journal(join(f.directory, '.local/stage0.sqlite'));
    try {
      assert.equal((j.db.prepare('SELECT COUNT(*) AS n FROM effects').get() as any).n, 26);
      assert.equal((j.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as any).n, 0);
    } finally { j.close(); }
    assert.equal(f.run(false).status, 2); // Completed reports are inspection-only, not regenerated.
    assert.equal(Number(readFileSync(join(f.directory, 'fetch-count.json'), 'utf8')), 0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
test('quota failure stops after one attempt and an UNKNOWN effect cannot be retried by resuming', async () => {
  const f = await fixture();
  try {
    const first = f.run(true); assert.equal(first.status, 2);
    assert.equal(JSON.parse(first.stdout).modelCallsThisInvocation, 1);
    assert.equal(Number(readFileSync(join(f.directory, 'fetch-count.json'), 'utf8')), 1);
    assert.equal(existsSync(join(f.directory, '.local/evaluation/benchmark-v1/report.json')), false);
    const second = f.run(false); assert.equal(second.status, 2);
    assert.equal(JSON.parse(second.stdout).code, 'BENCHMARK_UNCERTAIN_EFFECT');
    assert.equal(Number(readFileSync(join(f.directory, 'fetch-count.json'), 'utf8')), 0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
