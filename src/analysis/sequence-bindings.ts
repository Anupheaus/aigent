import { canonicalJson } from '../core/canonical-json.js';
import type { ArgTemplate } from '../learning/skills/skill-types.js';
import { isWorkStep } from '../scoring/work-steps.js';
import type { RunTrace, TraceStep } from '../telemetry/run-record.js';
import type { MinedSequence } from './sequence-mining.js';

/** One run's steps for a mined sequence (its first occurrence in that run), in order. */
export interface AlignedOccurrence {
  runId: string;
  steps: TraceStep[];
}

/** A parameter: an argument that varied across runs, with each run's value in occurrence order. */
export interface BoundParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  values: unknown[];
}

/** How every argument of every step is bound, or why it cannot be. */
export type SequenceBinding =
  | { ok: true; steps: { tool: string; args: Record<string, ArgTemplate> }[]; params: BoundParam[] }
  | { ok: false; reason: string };

/** Each supporting run's first occurrence of the sequence, sorted by run id. */
export function alignOccurrences(params: { sequence: MinedSequence; traces: RunTrace[] }): AlignedOccurrence[] {
  const { sequence, traces } = params;
  const stepsByRun = new Map(traces.map(({ run, steps }) => [run.runId, steps]));
  const seen = new Set<string>();
  return sequence.occurrences.flatMap(({ runId, startIndex, endIndex }) => {
    if (seen.has(runId)) return [];
    seen.add(runId);
    const steps = (stepsByRun.get(runId) ?? []).filter(step => isWorkStep(step) && step.index >= startIndex && step.index <= endIndex).sort((left, right) => left.index - right.index);
    return [{ runId, steps }];
  });
}

function scalarType(value: unknown): BoundParam['type'] | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? typeof value as BoundParam['type'] : undefined;
}

function argsOf(step: TraceStep): Record<string, unknown> | undefined {
  const { args } = step;
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
}

/** The latest earlier step whose result held each run's value at one path, preferring the shortest path. */
function fromStepBinding(params: { occurrences: AlignedOccurrence[]; stepIndex: number; values: unknown[] }): ArgTemplate | undefined {
  const { occurrences, stepIndex, values } = params;
  const [first] = occurrences;
  for (let earlier = stepIndex - 1; earlier >= 0; earlier -= 1) {
    const candidates = (first?.steps[earlier]?.resultLeaves ?? []).filter(({ value }) => value === values[0]).map(({ path }) => path).sort((left, right) => left.length - right.length || (left < right ? -1 : 1));
    const path = candidates.find(candidate => occurrences.every(({ steps }, run) => steps[earlier]?.resultLeaves?.some(leaf => leaf.path === candidate && leaf.value === values[run]) === true));
    if (path != null) return { fromStep: earlier, path };
  }
  return undefined;
}

/**
 * Aligns argument values across the supporting runs: equal in every run is a constant, equal to an earlier step's
 * result value in every run is a `fromStep` binding, anything else is a parameter (scalars of one type only). Refuses
 * steps without captured arguments, arguments whose names differ between runs and parameters that are not scalars.
 */
export function bindSequenceArguments(occurrences: AlignedOccurrence[]): SequenceBinding {
  const [first] = occurrences;
  if (first == null) return { ok: false, reason: 'no supporting runs' };
  const params: BoundParam[] = [];
  const steps: { tool: string; args: Record<string, ArgTemplate> }[] = [];
  for (const [stepIndex, step] of first.steps.entries()) {
    const perRun = occurrences.map(({ steps: runSteps }) => runSteps[stepIndex]);
    const argsPerRun = perRun.map(runStep => (runStep == null ? undefined : argsOf(runStep)));
    if (argsPerRun.some(args => args == null)) return { ok: false, reason: `step ${stepIndex + 1} (${step.tool}) has no captured arguments in every run (content capture off?)` };
    const names = Object.keys(argsPerRun[0] as Record<string, unknown>).sort();
    if (argsPerRun.some(args => canonicalJson(Object.keys(args as Record<string, unknown>).sort()) !== canonicalJson(names))) return { ok: false, reason: `step ${stepIndex + 1} (${step.tool}) takes different arguments in different runs` };
    const args: Record<string, ArgTemplate> = {};
    for (const name of names) {
      const values = argsPerRun.map(runArgs => (runArgs as Record<string, unknown>)[name]);
      if (values.every(value => canonicalJson(value) === canonicalJson(values[0]))) { args[name] = { const: values[0] }; continue; }
      const fromStep = fromStepBinding({ occurrences, stepIndex, values });
      if (fromStep != null) { args[name] = fromStep; continue; }
      const types = new Set(values.map(scalarType));
      const [type] = [...types];
      if (types.size !== 1 || type == null) return { ok: false, reason: `argument '${name}' of step ${stepIndex + 1} (${step.tool}) varies but is not a scalar of one type` };
      const paramName = params.some(param => param.name === name) ? `${name}_${stepIndex + 1}` : name;
      params.push({ name: paramName, type, values });
      args[name] = { param: paramName };
    }
    steps.push({ tool: step.tool, args });
  }
  return { ok: true, steps, params };
}
