// Presentation-only translation. Raw evidence and model responses stay verbatim.
import { assert } from './domain.ts';
import { publicDemoHtml } from './public-demo-view.ts';

const stageLabels = [
  'Fresh session: digest is still required',
  'Control: only sequenceNumber is required, budget 1',
  'After correction: Atlas is repaired, budget 1',
];
export function englishPresentationData(source: any) {
  const data = structuredClone(source);
  assert(data.stages.length === stageLabels.length, 'ENGLISH_STAGE_COUNT_CHANGED');
  data.stages.forEach((stage: any, i: number) => { stage.label = stageLabels[i]; });
  data.historicalNegativePilot.title = 'Saved 8B pilot: failure with and without memory.';
  return data;
}
export function englishPresentationReport(source: any, sourceHash: string) {
  const report = structuredClone(source);
  assert(report.rows.length === stageLabels.length, 'ENGLISH_REPORT_COUNT_CHANGED');
  report.rows.forEach((row: any, i: number) => { row.label = stageLabels[i]; });
  report.publishedLocalization = { language: 'en', sourceReportCanonicalHash: sourceHash,
    changedPaths: ['rows[0].label', 'rows[1].label', 'rows[2].label'], rawResponses: 'VERBATIM' };
  return report;
}

const phrases: Record<string, string> = {
  'Без истории': 'No history',
  'Факты в контексте': 'Facts in context',
  'Восстановленная память': 'Restored memory',
  'Простой алгоритм': 'Simple algorithm',
  'Ссылка подтверждена': 'Citation supported',
  'Ссылка непроверяема': 'Citation unverifiable',
  'Детерминированное правило': 'Deterministic rule',
  'Ссылок на память нет': 'No memory citations',
  'Отказ': 'Declined',
  'Успешный результат': 'Successful result',
  'Ошибка результата': 'Failed result',
  'Требуемые поля прошли проверку': 'Required fields passed verification',
  'demo-кредита': 'demo credits',
  'demo-кредит': 'demo credit',
  'условная цена': 'illustrative cost',
  'Решение алгоритма': 'Algorithm decision',
  'Сохранённый ответ модели': 'Saved model response',
  'Проверка и допуск': 'Verification and action guard',
  'Требуется': 'Required',
  'Бюджет': 'Budget',
  'A, B и C используют один ответ: нерелевантная ошибка заранее отфильтрована.': 'A, B and C share one response: the irrelevant failure was filtered before selection.',
  'B и C используют один ответ: факты и восстановленная память дали одинаковый запрос.': 'B and C share one response: direct facts and restored memory produced the same request.',
  'Это не независимые испытания.': 'These are not independent trials.',
  'Успешный результат ≠ подтверждённая ссылка.': 'A successful result ≠ a supported citation.',
  'Модель указала правильную correction-запись, но её pass-ссылка остаётся unverifiable по текущему контракту. Без истории эта точка тоже проходит.': 'The model cited the correct correction record, but its pass citation remains unverifiable under the current contract. This point also passes without history.',
  'Требования задачи и доступные проекции': 'Task requirements and available projections',
  'Синтетический пример · реальная запись Mainnet': 'Synthetic example · real Mainnet record',
  'Tatum · собственная управляемая demo-проекция': 'Tatum · controlled, owned demo projection',
  'Замещает': 'Supersedes',
  'Receipt, blob и содержимое записи': 'Receipt, blob and original record',
  'Recall Lab: проверяемая память для агента. Сохранённые реальные результаты, 10 записей Mainnet и честные ограничения.': 'Recall Lab: verifiable memory for Sui agents. Saved real results, 10 Mainnet records and honest limitations.',
  'Recall Lab — проверяемая память': 'Recall Lab — Verifiable Memory',
  'К содержанию': 'Skip to content',
  'Доказательства опыта': 'Evidence of experience',
  'Разделы демо': 'Demo sections',
  'Четыре сравнения': 'Four comparisons',
  'Обзор': 'Overview',
  'Память': 'Memory',
  'Границы результата': 'Limitations',
  'Локальная подготовка': 'Static demo',
  'Не опубликовано<br>Без запросов к API': 'Saved results<br>No API calls',
  'СОХРАНЁННЫЕ ДАННЫЕ · REPLAY': 'SAVED EVIDENCE · REPLAY',
  'ПАМЯТЬ ДЛЯ АГЕНТА · SUI / WALRUS / TATUM': 'AGENT MEMORY · SUI / WALRUS / TATUM',
  'Опыт, который<br>можно проверить': 'Experience you<br>can verify',
  'Агент выбирает Sui demo-проекцию, учитывая прошлую ошибку. Проверенный опыт сохраняется, восстанавливается новым клиентом и исправляется через correction-запись.': 'An agent selects a Sui demo projection using a verified past failure. Experience is saved, restored by a fresh client and updated through a correction record.',
  'Посмотреть результат': 'See the results',
  'Открыть память': 'Explore memory',
  'ПУТЬ ОДНОГО РЕШЕНИЯ': 'ONE DECISION, STEP BY STEP',
  'Наблюдение': 'Observation',
  'У Atlas отсутствует digest': 'Atlas is missing digest',
  'Сохранённый опыт': 'Saved experience',
  'Реальная запись в Walrus Mainnet': 'Real Walrus Mainnet record',
  'Восстановление': 'Recall',
  'Другой клиент, тот же факт': 'A fresh client, the same fact',
  'Следующий выбор': 'Next selection',
  'Beacon проходит проверку': 'Beacon passes verification',
  'Здесь показаны сохранённые ответы и локально пересчитанные проверки.': 'This page replays saved responses and locally recomputed checks.',
  'Состав доказательств': 'Evidence at a glance',
  'реальных записей Mainnet': 'real Mainnet memory records',
  'цепочек с correction': 'correction chains',
  'сохранённых ответов LLM': 'saved unique LLM responses',
  'новых расходов этого демо': 'additional spend in this demo',
  '01 / ПРОВЕРКА ПОЛЬЗЫ': '01 / TESTING THE BENEFIT',
  'Что изменилось с памятью': 'What changed with memory',
  'сохранённый запуск 28 октября': 'saved run from 28 October',
  'Один известный сценарий и два контроля. Без истории —': 'One known scenario and two controls. No history:',
  'успешных точек; с фактами, памятью и алгоритмом —': 'successful points; direct facts, memory and rules:',
  'Это не статистическая оценка качества.': 'This is not a statistical quality estimate.',
  'Точки сценария': 'Scenario points',
  'Повтор задачи': 'Repeat task',
  'Смена требований': 'Changed requirements',
  'После correction': 'After correction',
  'В основной точке опыт помог избежать повторной ошибки.': 'In the main task, experience helped avoid repeating a failure.',
  'Прямые факты и восстановленная память дали один и тот же запрос. Простой алгоритм получил такой же результат. Преимущество LLM над алгоритмом не доказано.': 'Direct facts and restored memory produced the same request. The simple algorithm achieved the same result. LLM superiority over the algorithm is not established.',
  '02 / СОХРАННОСТЬ И ИСПРАВЛЕНИЯ': '02 / PERSISTENCE AND CORRECTIONS',
  'История остаётся проверяемой': 'History stays inspectable',
  'Исходная пара Atlas и четыре дополнительные пары. Независимые live-клиенты ранее подтвердили чтение. При подготовке этой страницы новый локальный процесс заново проверил сохранённые записи, revisions и cutoff без ключей и сети.': 'The original Atlas pair and four additional pairs. Independent live clients previously verified reads. To prepare this page, a fresh local process checked the saved records, revisions and cutoff again without credentials or network access.',
  'Найти запись': 'Find a record',
  'Сервис, ID или вердикт': 'Service, ID or verdict',
  'Тип': 'Type',
  'Все записи': 'All records',
  'Только correction': 'Corrections only',
  'Синтетические': 'Synthetic examples',
  'Показано': 'Showing',
  'из': 'of',
  'записей': 'records',
  'Таких записей нет. Измените поиск или фильтр.': 'No matching records. Change the search or filter.',
  'Correction-цепочки': 'Correction chains',
  'Новая запись замещает прежнюю в том же scope после своего cutoff.': 'A new record supersedes its parent within the same scope after its cutoff.',
  'Память сама не чинит сервис. Старый сломанный код продолжает давать fail или unknown даже после pass-записи.': 'Memory does not repair a service. The old faulty code still returns fail or unknown even after a pass record.',
  '03 / ЧЕСТНЫЕ ГРАНИЦЫ': '03 / HONEST LIMITATIONS',
  'Что результат позволяет утверждать': 'What the evidence supports',
  'ПОДТВЕРЖДЕНО В ЭТОМ СЦЕНАРИИ': 'SUPPORTED IN THIS SCENARIO',
  'Проверенный факт меняет выбор': 'A verified fact changes the choice',
  'В основной точке A выбрал Atlas с ошибкой, B/C выбрали Beacon с pass и подтверждённой ссылкой. Хранение и переносимость проверены ранее реальными независимыми чтениями.': 'In the main task, A selected Atlas and failed; B/C selected Beacon and passed with a supported citation. Persistence and portability were previously verified through real independent reads.',
  'ОГРАНИЧЕНИЯ': 'LIMITATIONS',
  'Алгоритм справился так же': 'The algorithm did just as well',
  'Общее превосходство и стабильность LLM не установлены. B/C совпадают по построению. Прежние отрицательные пилоты сохранены. Pass-ссылка после correction остаётся непроверяемой.': 'General LLM superiority and stability are not established. B/C are identical by design. Earlier negative pilots are retained. The pass citation after correction remains unverifiable.',
  'ЧТО ИМЕННО ЗАПИСАНО': 'WHAT WAS ACTUALLY STORED',
  'Управляемые demo-проекции': 'Controlled demo projections',
  'Ошибки полей и устаревшие данные внесены в собственные проекции; это не реальные отказы Tatum или сторонних продавцов. Две history-записи — явно синтетический пример, реально сохранённый в Mainnet.': 'Field failures and stale data were injected into our own projections; these are not real Tatum or third-party vendor outages. Two history records are explicitly synthetic examples actually stored on Mainnet.',
  'Ранний 8B-пилот дал отрицательный результат:': 'An earlier 8B pilot had a negative result:',
  'Atlas/fail без памяти и с памятью. Новый положительный пример не доказывает стабильность модели. Переносимость проверялась новыми клиентами того же аккаунта; доступ между аккаунтами не проверялся.': 'Atlas/fail with and without memory. A new positive example does not establish model stability. Fresh clients verified portability within the same account; cross-account access was not tested.',
  'Сохранённый отрицательный пилот и его условия': 'Saved negative pilot and its conditions',
  'Проверить исходные данные': 'Inspect the source evidence',
  'Пять уникальных вызовов в сохранённом запуске. В этом демо: API 0, записи 0, новые расходы $0. Суммы в карточках — условные demo-кредиты.': 'Five unique model calls in the saved run. This demo makes 0 API calls and 0 writes, with $0 additional spend. Card prices are illustrative demo credits.',
  'Отчёт:': 'Report:',
  'Скачать данные JSON': 'Download evidence JSON',
  'Происхождение и границы проверки': 'Provenance and verification boundaries',
  'JavaScript отключён: все три точки и записи доступны ниже/выше. Переключатели, поиск и скачивание JSON требуют JavaScript.': 'JavaScript is disabled: all three points and records remain available. Scenario controls, search and JSON download require JavaScript.',
  'Локальный пакет · не опубликован · новые API-вызовы отключены': 'Static demo · saved evidence · no new API calls',
};

export function englishPublicDemoHtml(data: any, css: string, client: string) {
  const counter = 'Показано ${count} из ${records.length} записей';
  assert(client.includes(counter), 'ENGLISH_CLIENT_COUNTER_SOURCE_CHANGED');
  const englishClient = client.replace(counter, 'Showing ${count} of ${records.length} records');
  const html = publicDemoHtml(data, css, englishClient);
  const entries = Object.entries(phrases).sort((a, b) => b[0].length - a[0].length);
  // Keep embedded data and original evidence disclosures byte-for-byte intact.
  const parts = html.split(/(<pre\b[^>]*>[\s\S]*?<\/pre>|<script\b[^>]*>[\s\S]*?<\/script>)/g);
  const translated = parts.map(part => {
    if (/^<(pre|script)\b/.test(part)) return part;
    for (const [ru, en] of entries) part = part.split(ru).join(en);
    assert(!/[\u0400-\u04ff]/.test(part), 'ENGLISH_INTERFACE_TRANSLATION_MISSING');
    return part;
  }).join('').replace('<html lang="ru">', '<html lang="en">');
  return translated.replace('Total Recall</span><span>Static', 'Total Recall <span class="footer-sep">/</span> <a href="./blog.html">Article</a></span><span>Static');
}
