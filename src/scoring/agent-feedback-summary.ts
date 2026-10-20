import type { AgentFeedbackKind, AgentFeedbackRecord } from '../feedback/feedback-records.js';
import { groupSorted } from './finding-rules.js';
import type { AgentFeedbackKindCount, AgentFeedbackQuote, AgentFeedbackSummary, AgentFeedbackToolCount } from './report-types.js';

/** Quoted entries per agent: enough to read what the agent keeps saying without flooding the report. */
export const MAX_RECENT_AGENT_FEEDBACK = 10;

export interface SummariseAgentFeedbackParams {
  /** Stored `aigent_feedback` entries, in any order. */
  records: AgentFeedbackRecord[];
  /** The report's runs: entries of other runs are left out. */
  runIds: Set<string>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countByKind(records: AgentFeedbackRecord[]): AgentFeedbackKindCount[] {
  return groupSorted({ items: records, keyOf: ({ entry: { kind } }) => kind })
    .map(([kind, entries]) => ({ kind: kind as AgentFeedbackKind, count: entries.length }))
    .sort((left, right) => right.count - left.count || compareText(left.kind, right.kind));
}

function countByTool(records: AgentFeedbackRecord[]): AgentFeedbackToolCount[] {
  const aboutTools = records.filter(({ entry: { relatedTool } }) => relatedTool != null);
  return groupSorted({ items: aboutTools, keyOf: ({ entry: { relatedTool } }) => relatedTool as string })
    .map(([tool, entries]) => ({ tool, count: entries.length, byKind: countByKind(entries) }))
    .sort((left, right) => right.count - left.count || compareText(left.tool, right.tool));
}

/** Newest first; ties keep a fixed order (run, call, entry index) so reports are deterministic. */
function compareNewest(left: AgentFeedbackRecord, right: AgentFeedbackRecord): number {
  return right.recordedAt - left.recordedAt || compareText(left.runId, right.runId) || compareText(left.callId, right.callId) || left.index - right.index;
}

function recentQuotes(records: AgentFeedbackRecord[]): AgentFeedbackQuote[] {
  return records
    .filter(({ entry: { text } }) => text != null)
    .sort(compareNewest)
    .slice(0, MAX_RECENT_AGENT_FEEDBACK)
    .map(({ runId, recordedAt, entry: { kind, relatedTool, text } }) => ({ runId, recordedAt, kind, ...(relatedTool == null ? {} : { relatedTool }), text: text as string }));
}

/** Per agent, what it reported through `aigent_feedback` on the given runs: counts by kind and tool, and recent texts. */
export function summariseAgentFeedback(params: SummariseAgentFeedbackParams): AgentFeedbackSummary[] {
  const { records, runIds } = params;
  const relevant = records.filter(({ runId }) => runIds.has(runId));
  return groupSorted({ items: relevant, keyOf: ({ agentName }) => agentName }).map(([agentName, agentRecords]) => ({
    agentName,
    total: agentRecords.length,
    byKind: countByKind(agentRecords),
    byTool: countByTool(agentRecords),
    recent: recentQuotes(agentRecords),
  }));
}
