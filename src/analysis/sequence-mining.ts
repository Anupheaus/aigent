import { compareRunOrder } from '../scoring/baseline.js';
import { isWorkStep } from '../scoring/work-steps.js';
import type { RunTrace, StepOutcome, TraceStep } from '../telemetry/run-record.js';

/** Where a sequence occurred: step indexes (`TraceStep.index`) of its first and last step. */
export interface SequenceOccurrence {
  runId: string;
  startIndex: number;
  endIndex: number;
}

/** A run of consecutive tool calls that recurs across runs and ends in a step the agent called a success. */
export interface MinedSequence {
  tools: string[];
  /** Distinct runs it occurred in. */
  support: number;
  /** Sorted. */
  runIds: string[];
  occurrences: SequenceOccurrence[];
}

export interface MineSequencesOptions {
  minLength: number;
  maxLength: number;
  /** Distinct runs a sequence needs. */
  minSupport: number;
}

const DEFAULT_OPTIONS: MineSequencesOptions = { minLength: 2, maxLength: 5, minSupport: 3 };
const KEY_SEPARATOR = '\u0000';

interface Candidate {
  tools: string[];
  runIds: Set<string>;
  occurrences: SequenceOccurrence[];
}

/**
 * Each work step's outcome. An inner `aigent_multi` call has none of its own, so the batch's last inner call carries the
 * batch's outcome: the agent judged the batch as a whole.
 */
function effectiveOutcomes(steps: TraceStep[]): Map<number, StepOutcome | undefined> {
  const outcomeByCall = new Map(steps.filter(({ parentCallId }) => parentCallId == null).map(({ callId, outcome }) => [callId, outcome]));
  const lastInnerIndex = new Map<string, number>();
  for (const { parentCallId, index } of steps) if (parentCallId != null) lastInnerIndex.set(parentCallId, index);
  return new Map(steps.map(step => {
    const { index, parentCallId, outcome } = step;
    if (parentCallId == null) return [index, outcome];
    return [index, lastInnerIndex.get(parentCallId) === index ? outcomeByCall.get(parentCallId) : undefined];
  }));
}

/** A window made only of calls from one batch is the model's own batching, not a path worth a tool. */
function isWithinOneBatch(window: TraceStep[]): boolean {
  const [first] = window;
  return first?.parentCallId != null && window.every(({ parentCallId }) => parentCallId === first.parentCallId);
}

function collectWindows(params: { trace: RunTrace; options: MineSequencesOptions; candidates: Map<string, Candidate> }): void {
  const { trace: { run: { runId }, steps }, options: { minLength, maxLength }, candidates } = params;
  const work = [...steps].sort((left, right) => left.index - right.index).filter(isWorkStep);
  const outcomes = effectiveOutcomes(steps);
  work.forEach((endStep, endPosition) => {
    if (outcomes.get(endStep.index)?.success !== true) return;
    for (let length = minLength; length <= maxLength && length <= endPosition + 1; length += 1) {
      const window = work.slice(endPosition - length + 1, endPosition + 1);
      if (isWithinOneBatch(window)) continue;
      const tools = window.map(({ tool }) => tool);
      const key = tools.join(KEY_SEPARATOR);
      const candidate = candidates.get(key) ?? { tools, runIds: new Set<string>(), occurrences: [] };
      candidate.runIds.add(runId);
      candidate.occurrences.push({ runId, startIndex: (window[0] as TraceStep).index, endIndex: endStep.index });
      candidates.set(key, candidate);
    }
  });
}

function containsContiguously(params: { outer: string[]; inner: string[] }): boolean {
  const { outer, inner } = params;
  if (inner.length >= outer.length) return false;
  for (let start = 0; start + inner.length <= outer.length; start += 1) {
    if (inner.every((tool, offset) => outer[start + offset] === tool)) return true;
  }
  return false;
}

/** A sequence is only reported in its longest form: a part that occurs in no other runs adds nothing. */
function isSubsumed(params: { sequence: Candidate; all: Candidate[] }): boolean {
  const { sequence, all } = params;
  return all.some(other => containsContiguously({ outer: other.tools, inner: sequence.tools }) && [...sequence.runIds].every(runId => other.runIds.has(runId)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Frequent contiguous tool sequences that end in a step the agent reported as a success, counted in distinct runs.
 * Runs the user rated incorrect are never used. Deterministic: input order never matters.
 */
export function mineSequences(traces: RunTrace[], options: MineSequencesOptions = DEFAULT_OPTIONS): MinedSequence[] {
  const candidates = new Map<string, Candidate>();
  const seeds = traces.filter(({ run }) => run.userVerdict !== 'incorrect').sort((left, right) => compareRunOrder(left.run, right.run));
  for (const trace of seeds) collectWindows({ trace, options, candidates });
  const frequent = [...candidates.values()].filter(({ runIds }) => runIds.size >= options.minSupport);
  return frequent
    .filter(sequence => !isSubsumed({ sequence, all: frequent }))
    .map(({ tools, runIds, occurrences }) => ({
      tools,
      support: runIds.size,
      runIds: [...runIds].sort(compareText),
      occurrences: [...occurrences].sort((left, right) => compareText(left.runId, right.runId) || left.startIndex - right.startIndex),
    }))
    .sort((left, right) => right.support - left.support || right.tools.length - left.tools.length || compareText(left.tools.join(' '), right.tools.join(' ')));
}
