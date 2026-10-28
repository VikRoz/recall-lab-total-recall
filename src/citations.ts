import { assert, compatible, decision, experience, validateTask } from './domain.ts';
import type { Context } from './domain.ts';
import { applicable } from './memory.ts';
import { fieldFailureRelevance } from './field-failure.ts';

export const CITATION_CONTRACT = 'memory-citations-v1';
export type CitationStatus = 'none_available' | 'not_declared' | 'supported' | 'inapplicable' | 'irrelevant' | 'unverifiable' | 'contradicted';
export type MemoryAssessment = { id: string; declared: boolean;
  relevance: 'relevant_failure' | 'irrelevant_field' | 'unassessable' | 'inapplicable'; reasons: string[] };

// An audit of declared support, not a selector, inferred model intent, or a model repair.
export function assessCitations(context: Context, rawDecision: unknown) {
  validateTask(context.task);
  assert(context.memories.length <= 6 && new Set(context.memories.map(e => e.id)).size === context.memories.length,
    'CITATION_CONTEXT_INVALID');
  const records = context.memories.map(experience);
  const selected = decision(rawDecision, context); // Keep exact schema and reference checks.
  const active = new Set(applicable(records, context.task, context.offers).map(e => e.id));
  const assessments: MemoryAssessment[] = records.map(record => {
    const base = { id: record.id, declared: selected.memoryIds.includes(record.id) };
    const offer = context.offers.find(o => o.id === record.serviceId && o.version === record.serviceVersion);
    if (!active.has(record.id) || !offer || !offer.families.includes(context.task.family)
      || offer.network !== context.task.network || !compatible(context.task, offer)) return { ...base, relevance: 'inapplicable', reasons: ['scope_time_or_revision'] };
    const relevance = fieldFailureRelevance(record, context.task);
    if (relevance === 'relevant_failure') {
      return { ...base, relevance: 'relevant_failure', reasons: ['required_field_failure_same_version'] };
    }
    if (relevance === 'irrelevant_field') {
      return { ...base, relevance: 'irrelevant_field', reasons: ['failed_fields_not_required_now'] };
    }
    // E.g. old freshness without the original numeric age cannot prove a new threshold.
    return { ...base, relevance: 'unassessable', reasons: ['observation_contract_insufficient'] };
  });
  const declared = assessments.filter(e => e.declared);
  const contradicted = declared.some(e => e.relevance === 'relevant_failure'
    && records.find(r => r.id === e.id)!.serviceId === selected.serviceId);
  let status: CitationStatus;
  if (!records.length) status = 'none_available';
  else if (!declared.length) status = 'not_declared';
  else if (declared.some(e => e.relevance === 'inapplicable')) status = 'inapplicable';
  else if (contradicted) status = 'contradicted';
  else if (declared.some(e => e.relevance === 'irrelevant_field')) status = 'irrelevant';
  else if (declared.some(e => e.relevance === 'unassessable')) status = 'unverifiable';
  else status = 'supported';
  return { contract: CITATION_CONTRACT, status, citationGatePassed: status === 'supported',
    providedMemoryIds: records.map(e => e.id), declaredMemoryIds: [...selected.memoryIds], assessments };
}

export function auditEvaluationReport(report: any) {
  assert(report && Array.isArray(report.rows) && report.rows.length > 0 && report.rows.length <= 96, 'CITATION_REPORT_INVALID');
  const rows = report.rows.map((row: any) => {
    const base = { caseId: row.caseId, selector: row.selector, memoryEnabled: row.memoryEnabled,
      verifier: row.verdict, selectedServiceId: row.selectedServiceId };
    if (!row.decision || !row.context) return { ...base, audit: null, auditUnavailable: 'no_validated_decision' };
    return { ...base, audit: assessCitations(row.context, row.decision) };
  });
  return { contract: CITATION_CONTRACT, sourceStatus: report.status, retrospective: true,
    newModelCalls: 0, tatumCalls: 0, walrusOperations: 0, rows,
    limitations: ['Citation support is separate from verifier success and does not establish causal model use.',
      'Unassessable observation conditions are reported, not guessed; action admission and historical scores are unchanged.'] };
}
