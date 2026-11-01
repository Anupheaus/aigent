import { canonicalJson } from '../../core/canonical-json.js';
import { isWorkStep } from '../../scoring/work-steps.js';
import type { RunTrace, TraceStep } from '../../telemetry/run-record.js';
import { bindStepArgs } from './skill-binding.js';
import type { SkillCandidate } from './skill-types.js';

/** What replaying a skill against its supporting traces found. */
export interface SkillValidation {
  /** Share of supporting runs reproduced exactly (0 without any). */
  replayPass: number;
  failures: { runId: string; reason: string }[];
}

/** The run's first window of work steps calling the skill's tools in order. */
function occurrenceIn(params: { steps: TraceStep[]; tools: string[] }): TraceStep[] | undefined {
  const { steps, tools } = params;
  const work = [...steps].sort((left, right) => left.index - right.index).filter(isWorkStep);
  for (let start = 0; start + tools.length <= work.length; start += 1) {
    const window = work.slice(start, start + tools.length);
    if (window.every((step, offset) => step.tool === tools[offset])) return window;
  }
  return undefined;
}

/** The run's parameter values: each parameter's recorded argument at the first step that takes it. */
function recordedParams(params: { candidate: SkillCandidate; window: TraceStep[] }): Record<string, unknown> {
  const { candidate, window } = params;
  const values: Record<string, unknown> = {};
  candidate.steps.forEach((step, stepIndex) => {
    for (const [name, template] of Object.entries(step.args)) {
      if (!('param' in template) || template.param in values) continue;
      values[template.param] = (window[stepIndex]?.args as Record<string, unknown> | undefined)?.[name];
    }
  });
  return values;
}

/** Replays one run with a recorded-result double: every bound call must be one the run made, ending where it ended. */
function replayRun(params: { candidate: SkillCandidate; trace: RunTrace }): string | undefined {
  const { candidate, trace } = params;
  const tools = candidate.steps.map(({ tool }) => tool);
  const window = occurrenceIn({ steps: trace.steps, tools });
  if (window == null) return 'the run does not contain the sequence';
  const declared = Object.keys((candidate.argsSchema.properties ?? {}) as Record<string, unknown>);
  const unknown = candidate.steps.flatMap(({ args }) => Object.values(args).flatMap(template => ('param' in template && !declared.includes(template.param) ? [template.param] : [])));
  if (unknown.length > 0) return `steps reference parameters the schema does not declare: ${[...new Set(unknown)].join(', ')}`;
  const double = new Map(trace.steps.map(step => [canonicalJson({ tool: step.tool, args: step.args ?? null }), step]));
  const values = recordedParams({ candidate, window });
  const replayed: TraceStep[] = [];
  for (const [stepIndex, step] of candidate.steps.entries()) {
    const bound = bindStepArgs({ args: step.args, params: values, valueAt: (fromStep, path) => replayed[fromStep]?.resultLeaves?.find(leaf => leaf.path === path)?.value });
    if (!bound.ok) return `step ${stepIndex + 1}: ${bound.reason}`;
    const recorded = double.get(canonicalJson({ tool: step.tool, args: bound.args }));
    if (recorded == null) return `step ${stepIndex + 1} (${step.tool}) was replayed with arguments the run never used`;
    replayed.push(recorded);
  }
  const final = replayed.at(-1);
  const expected = window.at(-1);
  if (final?.resultHash == null || final.resultHash !== expected?.resultHash) return 'the replay did not reach the run\'s final result';
  return undefined;
}

/**
 * The validation gate: replays the candidate against each supporting trace with a recorded-result tool double. Passes
 * (`replayPass` 1) only when every supporting run is reproduced exactly; a tampered trace, a binding to an unknown
 * parameter or a result the run never had fails it.
 */
export function validateSkill(candidate: SkillCandidate, traces: RunTrace[]): SkillValidation {
  const byRun = new Map(traces.map(trace => [trace.run.runId, trace]));
  const failures = candidate.supportingRunIds.flatMap(runId => {
    const trace = byRun.get(runId);
    const reason = trace == null ? 'the supporting run is not stored' : replayRun({ candidate, trace });
    return reason == null ? [] : [{ runId, reason }];
  });
  const total = candidate.supportingRunIds.length;
  return { replayPass: total === 0 ? 0 : (total - failures.length) / total, failures };
}
