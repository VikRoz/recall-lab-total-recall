import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('.', import.meta.url));
const read = name => readFileSync(join(root, name), 'utf8');
const json = name => JSON.parse(read(name));
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const checksums = json('CHECKSUMS.json');
  for (const [name, digest] of Object.entries(checksums)) {
    assert(!name.includes('/') && !name.startsWith('.'), 'Invalid package path');
    assert.equal(sha(readFileSync(join(root, name))), digest, 'Changed file: ' + name);
  }
  const data = json('demo-data.json'), model = json('model-report.json'), verification = json('verification.json');
  assert.equal(sha(canonical(model)), '36b5f462e753b8af3f98dec355ceeaa94fb0bb27bd6a0eb8d1e3ca7fdd17c22d');
  assert.equal(sha(canonical(data)), verification.dataHash);
  assert.equal(data.records.length, 10); assert.equal(data.chains.length, 5);
  for (const row of data.records) {
    assert.equal(sha(canonical(row.record)), row.hash);
    assert(['DONE', 'done'].includes(row.receipt.state));
  }
  assert.equal(data.providerCallsThisBuild, 0); assert.equal(verification.publication, 'NOT_PUBLISHED');
  assert.equal(model.effects.length, 5); assert(model.effects.every(e => e.state === 'DONE'));
  for (const condition of ['A', 'B', 'C', 'D']) {
    const count = model.rows.reduce((n, r) => n + Number(condition === 'D' ? r.D.goalCompleted : r.arms.find(a => a.condition === condition).goalCompleted), 0);
    assert.equal(data.totals[condition], count);
  }
  assert.equal(data.stages[2].arms[2].citationAudit.status, 'unverifiable');
  const html = read('index.html');
  assert(html.includes('connect-src &#39;none&#39;'));
  for (const [, body] of html.matchAll(/<script(?: type="application\/json" id="demo-data")?>([\s\S]*?)<\/script>/g)) {
    assert(html.includes('sha256-' + createHash('sha256').update(body).digest('base64')));
  }
  const embedded = html.match(/<script type="application\/json" id="demo-data">([\s\S]*?)<\/script>/);
  assert(embedded && canonical(JSON.parse(embedded[1])) === canonical(data));
  console.log(JSON.stringify({ status: 'LOCAL_PACKAGE_VERIFIED', records: 10, chains: 5,
    modelResponsesAlreadySaved: 5, providerCalls: 0, additionalSpendUSD: 0,
    browserVisualQA: 'NOT_PERFORMED', publication: 'NOT_PUBLISHED' }, null, 2));
} catch {
  console.error('PACKAGE_VERIFICATION_FAILED'); process.exitCode = 1;
}
