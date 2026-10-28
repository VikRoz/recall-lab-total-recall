import { lstatSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assert, canonical, Fault } from '../src/domain.ts';
import { rehearse } from './rehearse.ts';
import { replayCoverage, completeOriginalReceipts, COVERAGE_REHEARSAL_HASH } from '../src/rehearsal-coverage.ts';
import { rehearsalHtml, rehearsalRunbook } from '../src/rehearsal-view.ts';

globalThis.fetch = async () => { throw new Error('REHEARSAL_NETWORK_FORBIDDEN'); };
export async function rehearseTen(originalPath: string, coveragePath: string) {
  const path = resolve(coveragePath), stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072, 'REHEARSAL_COVERAGE_FILE_INVALID');
  const coverage = completeOriginalReceipts(await replayCoverage(JSON.parse(readFileSync(path, 'utf8'))),
    JSON.parse(readFileSync(originalPath, 'utf8')));
  const base = await rehearse(originalPath);
  const directory = mkdtempSync(join(tmpdir(), 'recall-ten-new-client-'));
  try {
    const child = spawnSync(process.execPath, ['--experimental-strip-types',
      fileURLToPath(new URL('./rehearse-ten-client.ts', import.meta.url)), path, resolve(originalPath)], {
      cwd: directory, env: { NODE_NO_WARNINGS: '1', TZ: 'UTC' }, encoding: 'utf8', timeout: 15000, maxBuffer: 1048576,
    });
    assert(!child.error && child.status === 0, 'REHEARSAL_TEN_NEW_PROCESS_FAILED');
    const fresh = JSON.parse(child.stdout);
    assert(fresh.status === 'OFFLINE_TEN_RECORD_REPLAY_VERIFIED' && fresh.coverageEvidenceHash === COVERAGE_REHEARSAL_HASH
      && fresh.processId === child.pid && fresh.processId !== process.pid && fresh.emptyWorkingDirectory
      && fresh.credentialEnvironment === 'NONE', 'REHEARSAL_TEN_CHILD_PROOF_INVALID');
    // Parent and independent child must compute the same four controls, not trust each other's answers.
    assert(canonical(fresh.pairs) === canonical(coverage.pairs) && canonical(fresh.records) === canonical(coverage.records)
      && fresh.originalEvidenceHash === base.evidenceHash, 'REHEARSAL_TEN_PROCESS_DISAGREEMENT');
    const before = coverage.pairs.map(p => ({ scope: p.scope, source: p.source, record: p.parent,
      savedVerdict: p.historicalBeforeVerdict, localControl: p.before }));
    const corrections = coverage.pairs.map(p => ({ scope: p.scope, source: p.source, record: p.correction,
      savedVerdict: p.historicalAfterVerdict, localControl: p.after, staleImplementation: p.staleImplementation }));
    return { ...base, status: 'UNIFIED_TEN_RECORD_REHEARSAL_VERIFIED', mainnetMemoriesAlreadyConfirmed: 10,
      coverage, historicalTwoRecordNewProcess: base.episodes[4],
      independentProcess: { checked: true, parentProcessId: process.pid, childProcessId: fresh.processId,
        credentialEnvironment: 'NONE', emptyWorkingDirectory: true, recordsVerified: 10,
        input: 'TWO_HASH_BOUND_PUBLIC_EVIDENCE_FILES', remoteRecallThisRun: false },
      episodes: [...base.episodes.slice(0, 4),
        { id: 'coverage-before', title: 'Первая волна: четыре наблюдения', label: 'Сохранённые Mainnet-записи · локальные проверки',
          summary: ['6 записей подтверждено ранее', 'Независимый live-клиент ранее прочитал исходную пару и четыре новых наблюдения. Здесь повторно проверяются сохранённые хеши и cutoff: два required-field отказа блокируют действие; freshness и синтетическая неопределённость сохраняют отдельный смысл.'],
          evidence: { savedReader: coverage.recordedReaders.find(r => r.wave === 'A'), controls: before } },
        { id: 'coverage-corrections', title: 'Четыре correction-цепочки', label: 'Сохранённые receipts · детерминированный replay',
          summary: ['10 / 10 · четыре новых correction', 'Каждая pass-запись замещает свой fail или unknown только после её cutoff и внутри того же scope. Новые записи не создаются. Все четыре локальные исправленные проекции проходят; старый сломанный вариант сохраняет fail или unknown даже при pass в памяти.'],
          evidence: { savedReader: coverage.recordedReaders.find(r => r.wave === 'B'), controls: corrections } },
        { id: 'new-process-ten', title: 'Новый локальный процесс: все 10 записей', label: 'Новый процесс без credentials · без remote recall',
          summary: ['10 записей · 4 цепочки перепроверены', 'Новый процесс в пустом рабочем каталоге получает только два публичных evidence-файла. Он заново проверяет все записи и квитанции, обе волны, revisions/cutoff и четыре пары before/after. Ответы совпадают с родительским процессом. Это новое локальное вычисление по сохранённому чтению.'],
          evidence: { status: fresh.status, records: fresh.records.map((r: any) => r.id), controls: fresh.pairs,
            emptyWorkingDirectory: true, credentialEnvironment: 'NONE', providerCalls: fresh.providerCalls,
            historicalOriginalAtlasControl: { status: base.episodes[4].status, output: base.episodes[4].output,
              staleImplementationControl: base.episodes[4].staleImplementationControl } } },
      ] };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'REHEARSAL_ARGUMENTS_INVALID');
    const output = process.argv.length === 4 ? resolve(process.argv[3]) : fileURLToPath(new URL('../dist/rehearsal-ten-v1/', import.meta.url));
    const report = await rehearseTen(fileURLToPath(new URL('../evidence/rehearsal-v1/input.json', import.meta.url)),
      fileURLToPath(new URL('../evidence/coverage-mainnet-v1/live-evidence.json', import.meta.url)));
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(output, 'index.html'), rehearsalHtml(report));
    writeFileSync(join(output, 'RUNBOOK.md'), rehearsalRunbook(report));
    console.log(JSON.stringify({ status: report.status, episodes: report.episodes.length,
      mainnetMemoriesAlreadyConfirmed: 10, correctionChains: report.coverage.newCoverageChains,
      providerCalls: report.providerCalls, additionalSpendLimitUSD: 0, outputs: output,
      independentProcess: report.independentProcess }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ status: 'REHEARSAL_TEN_BLOCKED', code: error instanceof Fault ? error.code : 'REHEARSAL_TEN_FAILED', providerCalls: 0 }));
    process.exitCode = 2;
  }
}
