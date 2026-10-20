import type { ToolSuggestion } from '../scoring/report-types.js';
import { mean, roundToTenth } from '../scoring/stats.js';
import { isWorkStep } from '../scoring/work-steps.js';
import type { RunTrace, TraceStep } from '../telemetry/run-record.js';
import type { MinedSequence, SequenceOccurrence } from './sequence-mining.js';

/** Longest tool name `defineTool` accepts. */
const MAX_TOOL_NAME_LENGTH = 64;
const NAME_JOINER = '_then_';
const SEQUENCE_JOINER = ' -> ';
/** A type placeholder written by content-free argument summaries, e.g. `"<string>"`. */
const SHAPE_PLACEHOLDER = /^<(\w+)>$/;
const UNKNOWN_TYPE = 'unknown';

interface Saving {
  tokens: number;
  turns: number;
  timeMs: number;
}

/** snake_case from the sequence's distinct tool names in order, e.g. `search_then_read`. */
function nameFor(tools: string[]): string {
  const parts = [...new Set(tools)].map(tool => tool.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  const name = parts.join(NAME_JOINER);
  return (/^[a-z]/.test(name) ? name : `tool_${name}`).slice(0, MAX_TOOL_NAME_LENGTH);
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'string') return SHAPE_PLACEHOLDER.exec(value)?.[1] ?? 'string';
  return typeof value;
}

/** Argument names and types of a call, from its captured arguments or its summary. */
function argumentsOf(step: TraceStep): [string, string][] {
  const { args, argsSummary } = step;
  let source: unknown = args;
  if (typeof source !== 'object' || source === null) {
    try {
      source = JSON.parse(argsSummary);
    } catch { // a summary cut at 120 characters is not valid JSON, so its argument names are unknown
      return [];
    }
  }
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return [];
  return Object.entries(source).map(([name, value]) => [name, typeOf(value)]);
}

/** The work steps an occurrence covers, in order. */
function stepsOf(params: { occurrence: SequenceOccurrence; stepsByRun: Map<string, TraceStep[]> }): TraceStep[] {
  const { occurrence: { runId, startIndex, endIndex }, stepsByRun } = params;
  return (stepsByRun.get(runId) ?? []).filter(step => isWorkStep(step) && step.index >= startIndex && step.index <= endIndex).sort((left, right) => left.index - right.index);
}

/** What one direct call would have saved: the intermediate results, the extra turns, and the time before the last call. */
function savingOf(steps: TraceStep[]): Saving {
  const first = steps[0];
  const last = steps.at(-1);
  if (first == null || last == null) return { tokens: 0, turns: 0, timeMs: 0 };
  return {
    tokens: steps.slice(0, -1).reduce((total, { resultTokens }) => total + resultTokens, 0),
    turns: new Set(steps.map(({ turn }) => turn)).size - 1,
    timeMs: Math.max(0, last.startedAtMs - first.startedAtMs),
  };
}

function proposedArgs(firstSteps: TraceStep[]): ToolSuggestion['proposedArgs'] {
  const types = new Map<string, string>();
  for (const [name, type] of firstSteps.flatMap(argumentsOf)) types.set(name, types.has(name) && types.get(name) !== type ? UNKNOWN_TYPE : type);
  return [...types.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([name, type]) => ({ name, type }));
}

function suggestionFor(params: { name: string; sequences: MinedSequence[]; stepsByRun: Map<string, TraceStep[]> }): ToolSuggestion {
  const { name, sequences, stepsByRun } = params;
  const [primary] = sequences as [MinedSequence, ...MinedSequence[]];
  const uses = sequences.flatMap(({ occurrences }) => occurrences.map(occurrence => stepsOf({ occurrence, stepsByRun })));
  const savings = uses.map(savingOf);
  const firstSteps = uses.flatMap(steps => (steps[0] == null ? [] : [steps[0]]));
  return {
    name,
    description: `One call that does what '${primary.tools.join(SEQUENCE_JOINER)}' did in ${primary.support} runs, returning the final result directly.`,
    replaces: sequences.map(({ tools }) => tools.join(SEQUENCE_JOINER)),
    supportingRunIds: [...new Set(sequences.flatMap(({ runIds }) => runIds))].sort(),
    proposedArgs: proposedArgs(firstSteps),
    estimatedSaving: {
      tokensPerUse: Math.round(mean(savings.map(({ tokens }) => tokens)) ?? 0),
      turnsPerUse: roundToTenth(mean(savings.map(({ turns }) => turns)) ?? 0),
      timePerUseMs: Math.round(mean(savings.map(({ timeMs }) => timeMs)) ?? 0),
    },
  };
}

/**
 * A tool suggestion per recurring sequence (sequences of the same tools share one suggestion), with the arguments
 * its first call took and the average saving per use. None when no sequence was mined.
 */
export function suggestTools(sequences: MinedSequence[], traces: RunTrace[]): ToolSuggestion[] {
  const stepsByRun = new Map(traces.map(({ run, steps }) => [run.runId, steps]));
  const byName = new Map<string, MinedSequence[]>();
  for (const sequence of sequences) {
    const name = nameFor(sequence.tools);
    byName.set(name, [...byName.get(name) ?? [], sequence]);
  }
  return [...byName.entries()].map(([name, named]) => suggestionFor({ name, sequences: named, stepsByRun }));
}
