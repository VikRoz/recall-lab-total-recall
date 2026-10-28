import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/local-journal.ts';
import { FixtureMemory } from '../src/fixtures.ts';

test('a confirmed provider response is reused after a process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-test-')); const path = join(dir, 'journal.sqlite');
  let calls = 0; let j = new Journal(path);
  try {
    assert.equal(await j.once('model:1', 'model', { task: 1 }, async () => ++calls), 1);
    j.close(); j = new Journal(path);
    assert.equal(await j.once('model:1', 'model', { task: 1 }, async () => ++calls), 1);
    assert.equal(calls, 1);
    await assert.rejects(() => j.once('model:1', 'model', { task: 2 }, async () => 2), /IDEMPOTENCY_CONFLICT/);
  } finally { j.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('lost model response cannot trigger automatic regeneration', async () => {
  const j = new Journal(':memory:'); let calls = 0;
  try {
    await assert.rejects(() => j.once('model:unknown', 'model', {}, async () => { calls++; throw new Error('raw secret is not logged'); }), /EFFECT_OUTCOME_UNKNOWN/);
    await assert.rejects(() => j.once('model:unknown', 'model', {}, async () => { calls++; return 1; }), /EFFECT_OUTCOME_UNKNOWN/);
    assert.equal(calls, 1);
  } finally { j.close(); }
});
test('concurrent invocation of the same model operation has one winner', async () => {
  const j = new Journal(':memory:'); let finish!: () => void; let calls = 0;
  try {
    const first = j.once('same', 'model', {}, () => new Promise<number>(resolve => { calls++; finish = () => resolve(1); }));
    await assert.rejects(() => j.once('same', 'model', {}, async () => { calls++; return 2; }), /EFFECT_OUTCOME_UNKNOWN/);
    finish(); await first; assert.equal(calls, 1);
  } finally { j.close(); }
});
test('accepted Walrus job is polled after restart without another submission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-outbox-')); const path = join(dir, 'journal.sqlite');
  const memory = new FixtureMemory(); let submits = 0, polls = 0;
  const remember = memory.remember.bind(memory), status = memory.status.bind(memory);
  memory.remember = async (text, key) => { submits++; return remember(text, key); };
  memory.status = async id => ++polls === 1 ? { state: 'pending', jobId: id } : status(id);
  let j = new Journal(path);
  try {
    j.plan('event:1', { fact: 'public synthetic' });
    assert.equal((await j.advance('event:1', memory)).state, 'pending');
    j.close(); j = new Journal(path);
    assert.equal((await j.advance('event:1', memory)).state, 'done');
    assert.equal((await j.advance('event:1', memory)).state, 'done');
    assert.equal(submits, 1); assert.equal(polls, 2);
  } finally { j.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('unknown write acceptance stops instead of creating a new job', async () => {
  const j = new Journal(':memory:'); const memory = new FixtureMemory(); let submits = 0;
  memory.remember = async () => { submits++; throw new Error('network'); };
  try {
    j.plan('event:lost', { x: 1 });
    await assert.rejects(() => j.advance('event:lost', memory), /WRITE_OUTCOME_UNKNOWN/);
    await assert.rejects(() => j.advance('event:lost', memory), /WRITE_OUTCOME_UNKNOWN/);
    assert.equal(submits, 1);
  } finally { j.close(); }
});
test('a completed status without a blob ID is not accepted as durability', async () => {
  const j = new Journal(':memory:'); const memory = new FixtureMemory();
  memory.status = async jobId => ({ state: 'done', jobId });
  try {
    j.plan('event:no-blob', { x: 1 });
    await assert.rejects(() => j.advance('event:no-blob', memory), /WRITE_RECEIPT_INVALID/);
    assert.equal(j.outbox('event:no-blob').state, 'ACCEPTED');
  } finally { j.close(); }
});
test('quota is reserved before inference and unknown outcomes keep their reservation', async () => {
  const j = new Journal(':memory:'); let calls = 0;
  try {
    for (let i = 0; i < 64; i++) await j.once('model:' + i, 'model', { i }, async () => ++calls);
    await assert.rejects(() => j.once('model:65', 'model', {}, async () => ++calls), /QUOTA_EXHAUSTED/);
    assert.equal(calls, 64);
  } finally { j.close(); }
});
