import type { ToolUse, TraceStep } from './run-record.js';

export interface SummariseToolUseParams {
  steps: TraceStep[];
  /** Wrappers and commentary (`aigent_multi`, `aigent_feedback`): not work in themselves. */
  nonWorkTools: string[];
}

/** How the run used its tools, so scoring can rate batching and repetition from the run record alone. */
export function summariseToolUse(params: SummariseToolUseParams): ToolUse {
  const { steps, nonWorkTools } = params;
  const skipped = new Set(nonWorkTools);
  const seen = new Set<string>();
  let calls = 0;
  let items = 0;
  let repeats = 0;
  for (const { tool, argsSummary, argsHash, itemTotal } of steps) {
    if (skipped.has(tool)) continue;
    calls += 1;
    // A batch call counts its items; any other call is one item of work.
    items += itemTotal ?? 1;
    // The digest covers the full arguments; the summary (a shape, or a 120-character prefix) is a fallback for old records.
    const signature = `${tool}\n${argsHash ?? argsSummary}`;
    if (seen.has(signature)) repeats += 1;
    seen.add(signature);
  }
  return { calls, items, repeats };
}
