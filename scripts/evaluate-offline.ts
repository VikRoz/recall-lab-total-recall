import { evaluationCorpus } from '../src/evaluation-corpus.ts';
import { deterministicModel, evaluateArm, FrozenMemory, hash, summarize } from '../src/evaluation.ts';

const cases = evaluationCorpus();
const rows = [];
for (const c of cases) for (const enabled of [false, true]) {
  rows.push(await evaluateArm(c, deterministicModel, new FrozenMemory(c.records), enabled));
}
console.log(JSON.stringify({ mode: 'OFFLINE_DETERMINISTIC_EVALUATION', chainData: 'SYNTHETIC',
  memory: 'FROZEN_SYNTHETIC_CORPUS', externalModelCalls: 0, externalReads: 0, mainnetWrites: 0,
  corpusHash: hash(cases), cases: cases.map(c => ({ id: c.id, purpose: c.purpose })),
  withoutMemory: summarize(rows.filter(r => !r.memoryEnabled)), withMemory: summarize(rows.filter(r => r.memoryEnabled)),
  rows, limitations: ['This is a deterministic control, not an LLM evaluation.',
    'No financial savings claim: prices are demo credits.', 'The same-family field-scope counterexample is retained.'] }, null, 2));
