import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assert, Fault } from '../src/domain.ts';
import { auditEvaluationReport } from '../src/citations.ts';
import { hash } from '../src/evaluation.ts';

// Local reports only. No provider adapters, credentials, journal mutations or inference.
try {
  const inputs = ['.local/evaluation/pilot-v1/report.json', '.local/evaluation/pilot-v2/report.json', '.local/evaluation/pilot-70b/report.json'];
  const audits = inputs.map(path => {
    assert(existsSync(path) && statSync(path).size <= 131072, 'CITATION_INPUT_MISSING_OR_LARGE');
    const text = readFileSync(path, 'utf8');
    return { sourcePath: path, sourceTextHash: hash(text), ...auditEvaluationReport(JSON.parse(text)) };
  });
  const output = { status: 'CITATION_AUDIT_COMPLETED', ...{ audits },
    modelCalls: 0, tatumCalls: 0, walrusOperations: 0 };
  const path = '.local/evaluation/citation-contract-v1/report.json';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) assert(hash(JSON.parse(readFileSync(path, 'utf8'))) === hash(output), 'CITATION_AUDIT_CHANGED');
  else writeFileSync(path, JSON.stringify(output, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'CITATION_AUDIT_BLOCKED', code: error instanceof Fault ? error.code : 'CITATION_AUDIT_FAILED', modelCalls: 0 }));
  process.exitCode = 2;
}
