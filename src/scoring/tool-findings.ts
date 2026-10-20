import type { RunTrace, TraceStep } from '../telemetry/run-record.js';
import { MIN_TOOL_CALLS, groupSorted, makeFinding } from './finding-rules.js';
import type { Finding } from './report-types.js';
import { median, roundRate } from './stats.js';
import { isWorkStep, topLevelWorkSteps } from './work-steps.js';

/** A tool is slow when its median call takes at least this long... */
const SLOW_TOOL_MIN_MS = 2_000;
/** ...and at least this many times the median of all the agent's tool calls. */
const SLOW_TOOL_FACTOR = 3;
/** Failure share that makes a tool worth a warning, and a bad finding. */
const FAILING_TOOL_WARN_RATE = 0.25;
const FAILING_TOOL_BAD_RATE = 0.5;
/** Median result size (estimated tokens) that makes a tool verbose. */
const VERBOSE_TOOL_TOKENS = 2_000;
/** Share of truncated results that is worth mentioning. */
const FREQUENT_TRUNCATION_RATE = 0.25;
/** Calls to one tool with the same argument shape in one run that should have been one batch. */
const UNBATCHED_REPEAT_CALLS = 3;

interface ToolCalls {
  agentName: string;
  tool: string;
  steps: TraceStep[];
}

function mostCommon(values: string[]): string | undefined {
  const counts = groupSorted({ items: values, keyOf: value => value }).map(([value, entries]) => ({ value, count: entries.length }));
  return counts.sort((left, right) => right.count - left.count)[0]?.value;
}

function slowTool(params: ToolCalls & { agentMedianMs: number }): Finding[] {
  const { agentName, tool, steps, agentMedianMs } = params;
  const medianDurationMs = median(steps.map(({ durationMs }) => durationMs)) ?? 0;
  if (medianDurationMs < SLOW_TOOL_MIN_MS || medianDurationMs < SLOW_TOOL_FACTOR * agentMedianMs) return [];
  return [makeFinding({
    kind: 'slow-tool', severity: 'warn', label: 'slow', agentName, subject: tool,
    message: `Tool '${tool}' takes ${medianDurationMs} ms per call (median), over ${SLOW_TOOL_FACTOR} times the agent's typical tool call`,
    evidence: { calls: steps.length, medianDurationMs, agentMedianDurationMs: agentMedianMs },
  })];
}

function failingTool(params: ToolCalls): Finding[] {
  const { agentName, tool, steps } = params;
  const failed = steps.filter(({ ok }) => !ok);
  const failureRate = roundRate(failed.length / steps.length);
  if (failureRate < FAILING_TOOL_WARN_RATE) return [];
  const commonErrorCategory = mostCommon(failed.flatMap(({ errorCategory }) => (errorCategory == null ? [] : [errorCategory])));
  return [makeFinding({
    kind: 'failing-tool', severity: failureRate >= FAILING_TOOL_BAD_RATE ? 'bad' : 'warn', label: 'inefficient', agentName, subject: tool,
    message: `Tool '${tool}' failed ${failed.length} of ${steps.length} calls${commonErrorCategory == null ? '' : `, mostly '${commonErrorCategory}'`}`,
    evidence: { calls: steps.length, failures: failed.length, failureRate, ...(commonErrorCategory == null ? {} : { commonErrorCategory }) },
  })];
}

function verboseTool(params: ToolCalls): Finding[] {
  const { agentName, tool, steps } = params;
  const medianResultTokens = median(steps.map(({ resultTokens }) => resultTokens)) ?? 0;
  if (medianResultTokens < VERBOSE_TOOL_TOKENS) return [];
  return [makeFinding({
    kind: 'verbose-tool', severity: 'warn', label: 'inefficient', agentName, subject: tool,
    message: `Tool '${tool}' returns about ${medianResultTokens} tokens per call (median); set maxResultTokens or return less`,
    evidence: { calls: steps.length, medianResultTokens },
  })];
}

function frequentTruncation(params: ToolCalls): Finding[] {
  const { agentName, tool, steps } = params;
  const truncated = steps.filter(step => step.truncated).length;
  if (truncated / steps.length < FREQUENT_TRUNCATION_RATE) return [];
  return [makeFinding({
    kind: 'truncation-frequent', severity: 'info', label: 'inefficient', agentName, subject: tool,
    message: `Tool '${tool}' had ${truncated} of ${steps.length} results truncated; add paging or narrower arguments`,
    evidence: { calls: steps.length, truncated },
  })];
}

/** The argument keys, which make calls "similar" even when their values differ. */
function argumentShape(step: TraceStep): string {
  const { args, argsSummary } = step;
  if (typeof args === 'object' && args !== null) return Object.keys(args).sort().join(',');
  try {
    const parsed: unknown = JSON.parse(argsSummary);
    return typeof parsed === 'object' && parsed !== null ? Object.keys(parsed).sort().join(',') : argsSummary;
  } catch { // a summary cut at 120 characters is not valid JSON; its text is the best shape left
    return argsSummary;
  }
}

function unbatchedRepeats(params: { agentName: string; tool: string; traces: RunTrace[] }): Finding[] {
  const { agentName, tool, traces } = params;
  const perRun = traces.map(({ run, steps }) => {
    const calls = topLevelWorkSteps(steps).filter(step => step.tool === tool);
    const largestGroup = Math.max(0, ...groupSorted({ items: calls, keyOf: argumentShape }).map(([, group]) => group.length));
    return { runId: run.runId, largestGroup };
  }).filter(({ largestGroup }) => largestGroup >= UNBATCHED_REPEAT_CALLS);
  if (perRun.length === 0) return [];
  const maxCallsInOneRun = Math.max(...perRun.map(({ largestGroup }) => largestGroup));
  return [makeFinding({
    kind: 'unbatched-repeats', severity: 'warn', label: 'inefficient', agentName, subject: tool,
    message: `Tool '${tool}' was called up to ${maxCallsInOneRun} times with similar arguments in one run; make it a batch tool or use aigent_multi`,
    evidence: { runIds: perRun.map(({ runId }) => runId).sort(), maxCallsInOneRun },
  })];
}

/** Per-tool findings for one agent's runs. */
export function toolFindings(params: { agentName: string; traces: RunTrace[] }): Finding[] {
  const { agentName, traces } = params;
  const workSteps = traces.flatMap(({ steps }) => steps.filter(isWorkStep));
  const agentMedianMs = median(workSteps.map(({ durationMs }) => durationMs)) ?? 0;
  return groupSorted({ items: workSteps, keyOf: ({ tool }) => tool }).flatMap(([tool, steps]) => {
    const unbatched = unbatchedRepeats({ agentName, tool, traces });
    if (steps.length < MIN_TOOL_CALLS) return unbatched;
    const calls: ToolCalls = { agentName, tool, steps };
    return [...slowTool({ ...calls, agentMedianMs }), ...failingTool(calls), ...verboseTool(calls), ...frequentTruncation(calls), ...unbatched];
  });
}
