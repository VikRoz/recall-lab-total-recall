import { lstatSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assert, Fault } from '../src/domain.ts';
import { buildMemoryScenario, prepareStage, finishScenario } from '../src/memory-scenario.ts';
import { hash } from '../src/evaluation.ts';
globalThis.fetch = async () => { throw new Error('SCENARIO_NETWORK_FORBIDDEN'); };

function load(path: string, limit: number) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'SCENARIO_SOURCE_FILE_INVALID');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export async function prepareMemoryScenario(originalPath: string, coveragePath: string) {
  const scenario = buildMemoryScenario(load(originalPath, 65536), load(coveragePath, 131072));
  const root = mkdtempSync(join(tmpdir(), 'recall-four-way-'));
  try {
    const snapshot = join(root, 'snapshot.json');
    writeFileSync(snapshot, JSON.stringify(scenario.snapshot), { mode: 0o600, flag: 'wx' });
    const restored = [];
    for (const stage of scenario.stages) {
      const request = join(root, stage.id + '-request.json'), cwd = join(root, stage.id + '-empty');
      mkdirSync(cwd, { mode: 0o700 });
      const input = prepareStage(stage, scenario.directFacts, scenario.snapshot).request;
      writeFileSync(request, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
      const child = spawnSync(process.execPath, ['--experimental-strip-types',
        fileURLToPath(new URL('./memory-scenario-client.ts', import.meta.url)), snapshot, request], {
        cwd, env: { NODE_NO_WARNINGS: '1', TZ: 'UTC' }, encoding: 'utf8', timeout: 15000, maxBuffer: 131072,
      });
      assert(!child.error && child.status === 0, 'SCENARIO_FRESH_RESTORE_FAILED');
      const result = JSON.parse(child.stdout);
      assert(result.processId === child.pid && result.processId !== process.pid && result.emptyWorkingDirectory
        && result.credentialEnvironment === 'NONE' && result.requestHash === hash(input), 'SCENARIO_CHILD_ATTESTATION_INVALID');
      restored.push(result);
    }
    const report = finishScenario(scenario, restored);
    return { report, scenario };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
export function scenarioRunbook(report: any) {
  const rows = report.stages.map((s: any) => `| ${s.label} | NOT_RUN | NOT_RUN | NOT_RUN | ${s.D.proposal.serviceId} / ${s.D.rawVerifier.status} |`).join('\n');
  return `# Конкретный offline-сценарий: опыт между сеансами

Дата:27 октября2026. Статус:${report.status}. Гипотеза:${report.hypothesisStatus}. Расходы:$0; новые API/model calls:0.

## Задача и происхождение опыта

Агенту нужны обязательные поля Sui checkpoint в пределах demo-бюджета. Atlas стоит1 demo credit, Beacon2. Это собственные контролируемые проекции сохранённых реальных Tatum данных, а не независимые внешние поставщики.

В исходной сессии сохранённая Llama выбрала Atlas; verifier обнаружил намеренный missing:digest. Настоящий memory record:${report.origin.record.id}; blob:${report.origin.receipt.blob_id}; job:${report.origin.receipt.job_id}. Новая генерация/запись здесь не производится. Последующая реальная correction:${report.correction.record.id}; supersedes:${report.correction.record.supersedes}; blob:${report.correction.receipt.blobId}.

## Один сценарий и два граничных контроля

1. **Повтор обязательного поля.** Новый task на сохранённом cutoff после failure, до correction. Нужны digest и sequenceNumber, бюджет2. Atlas по-прежнему намеренно не возвращает digest, Beacon возвращает оба поля. Контролируемый правильный исход — Beacon/pass.
2. **Поле больше не требуется.** На том же cutoff нужен только sequenceNumber, бюджет1. Atlas возвращает нужное. Сбой digest не оправдывает отказ. После действующего field filter память исчезает из модельного входа: A=B=C.
3. **Подтверждённое исправление.** После correction той же Atlas v1 нужен digest и sequenceNumber, бюджет1. Используется явно исправленная собственная проекция и сохранённый correction checkpoint. Atlas/pass; старая failure-запись больше не активна.

Это один известный development flow с двумя проверками границ, не три независимые новые задачи и не статистическое подтверждение гипотезы. Cutoffs/targets исторические; текущая сеть не проверяется.

## Четыре сравнения

| Ветка | Вход / механизм | Что действительно выполнено |
| --- | --- | --- |
| A — без истории | Тот же task/catalog, memories=[] | Подготовлен запрос; ответа LLM нет |
| B — факты в контексте | Исходные проверенные records напрямую, обычные scope/cutoff/field checks | Подготовлен запрос; ответа LLM нет |
| C — восстановленная память | Новый пустой процесс читает сохранённый snapshot всех10 records, проверяет полноту/hashes/revisions и применяет те же checks | Восстановление проверено; запрос подготовлен; ответа LLM нет |
| D — простой алгоритм | Те же факты C и существующие field-aware правила | Алгоритм реально выполнен offline и результат проверен |

| Контрольная точка | A: LLM | B: LLM | C: LLM | D: локальный результат |
| --- | --- | --- | --- | --- |
${rows}

## Что установлено offline

- Для каждого этапа B и C дают **одинаковые байты запроса модели**. Различается доставка фактов, а не подсказка. В контроле ненужного поля совпадают все A/B/C.
- Девять логических LLM-веток образуют **пять уникальных подготовленных запросов**. Это не разрешение на пять calls. Дубликаты не считаются независимыми попытками.
- Сохранённый snapshot содержит10 ранее подтверждённых records, но в Context остаётся1/0/1 record для трёх точек. Future corrections и неподходящие записи не доставляются модели.
- Каждый C выполнен новым процессом с пустым cwd и без унаследованных credentials; переданы только публичный snapshot и task/catalog/expected hashes. Oracle, прямые факты B, старые ответы модели и writer SQLite не передаются.
- Используется текущий default8B/V1 и прежний controlled-projection-v1; модель, prompt, serializer приложения и policy не меняются. В стенде применяется единое явное canonical encoding для всех веток. Каждый request прошёл текущий input≤3500 bytes / output≤512 / temperature0 contract.
- D дал Beacon/pass, Atlas/pass, Atlas/pass. Это результат кода, не LLM. Scripted grader/guard controls отдельно помечены и также не являются ответами модели.
- Raw proposal и counterfactual verifier на сохранённых байтах отделены от controllerOutcome. BLOCKED не превращается в успешное решение LLM, а оценка скрытого результата не отправляется модели.

## Артефакты и критерии

plan.json: immutable-by-hash описание, providerCallsAllowed=0. Контрольный hash:${report.planHash}.

model-inputs.json: только пять точных будущих request bodies и их связи с логическими ветками; без oracle и ключей. report.json: реальные offline-результаты и NOT_RUN для LLM. scenario.json: явно отделённые saved source/reference и локальные проекции для проверяющего кода. memory-snapshot.json: сохранённые публичные Walrus bytes, не live recall.

Критерий готовности **этой подготовки**: происхождение опыта/receipt/hashes подтверждено, B=C по запросам, требуемые поля/correction работают на фактах, запросы укладываются в действующие лимиты, D/проверяющий код воспроизводимы, ошибка восстановления останавливает подготовку без fallback. Эти проверки не устанавливают качество LLM.

Для будущего диагностического inference отдельно смотрим raw decision, verifier correctness, повтор ошибки, корректное применение irrelevant-field/correction, model-declared memoryIds и controller guard. Приготовленные ожидаемые исходы не выдаются модели. Если A без истории тоже даст правильный ответ, это фиксируется как отсутствие выигрыша в данной точке; вход не переделывается ради провала A. Здесь нет обоснованного sample size для статистического вывода и нет разрешённого live executor.

## Ограничения и следующий шаг

Цель — проверить измеримость одного сценария. H1/H2 пока NOT_TESTED. Превосходство Walrus над теми же байтами напрямую не предполагается. Преимущество LLM над правилами не предполагается. Не менять название задачи/промпт ради подходящего ответа и не выдавать прошлый model response за новую ветку.

Для новой генерации нужен отдельный утверждённый manifest, выбранная конфигурация и проверка Free/$0. Этот entry point не читает .env, не принимает --execute и не умеет обращаться к провайдерам. Сайт не создаётся, существующая репетиция не переписывается.
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'SCENARIO_ARGUMENTS_INVALID');
    const output = process.argv.length === 4 ? resolve(process.argv[3]) : fileURLToPath(new URL('../dist/memory-scenario-v1/', import.meta.url));
    const { report, scenario } = await prepareMemoryScenario(
      fileURLToPath(new URL('../evidence/rehearsal-v1/input.json', import.meta.url)),
      fileURLToPath(new URL('../evidence/coverage-mainnet-v1/live-evidence.json', import.meta.url)));
    mkdirSync(output, { recursive: true });
    for (const [name, data] of Object.entries({ 'report.json': report, 'scenario.json': scenario, 'plan.json': report.plan,
      'model-inputs.json': report.plan.requests, 'memory-snapshot.json': scenario.snapshot })) {
      writeFileSync(join(output, name), JSON.stringify(data, null, 2));
    }
    writeFileSync(join(output, 'SCENARIO.md'), scenarioRunbook(report));
    console.log(JSON.stringify({ status: report.status, hypothesisStatus: report.hypothesisStatus,
      planHash: report.planHash, stages: report.stages.length, logicalModelArms: report.plan.logicalModelArms,
      uniquePreparedRequests: report.plan.uniquePreparedRequests, measuredThisRun: report.measuredThisRun, output }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ status: 'OFFLINE_SCENARIO_BLOCKED', code: error instanceof Fault ? error.code : 'SCENARIO_PREPARATION_FAILED', providerCalls: 0 }));
    process.exitCode = 2;
  }
}
