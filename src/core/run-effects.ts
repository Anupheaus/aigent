import type { PlannedEffect } from '../effects/planned-effects.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { AigentEvent } from './aigent-events.js';

/** A run's side effects: in a dry run, the effects its calls would have had. */
export interface RunEffects {
  dryRun: boolean;
  /** Every planned effect so far, in call completion order. */
  planned: PlannedEffect[];
  /** Takes what a finished top-level call (and the calls inside it) did or would have done. */
  record(executed: ExecutedToolCall): void;
}

export function createRunEffects(params: { dryRun: boolean; emit(event: AigentEvent): void }): RunEffects {
  const { dryRun, emit } = params;
  const planned: PlannedEffect[] = [];
  return {
    dryRun,
    planned,
    record: ({ envelope: { id: callId }, plannedEffects = [] }) => {
      if (plannedEffects.length === 0) return;
      planned.push(...plannedEffects);
      emit({ type: 'planned-effects', callId, effects: plannedEffects });
    },
  };
}
