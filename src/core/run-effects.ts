import type { PlannedEffect } from '../effects/planned-effects.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { AigentEvent } from './aigent-events.js';
import type { EffectLog } from '../effects/effect-log.js';

/** A run's side effects: in a dry run, the effects its calls would have had; otherwise the effect log. */
export interface RunEffects {
  dryRun: boolean;
  /** Every planned effect so far, in call completion order. */
  planned: PlannedEffect[];
  /** Takes what a finished top-level call (and the calls inside it) did or would have done. */
  record(executed: ExecutedToolCall): void;
  /** Resolves once every effect so far is in the effect log (a failed write becomes a warning). */
  flush(): Promise<void>;
}

export interface CreateRunEffectsParams {
  dryRun: boolean;
  /** Where the run's effects are appended (absent: they are not recorded). */
  log?: EffectLog;
  ids: { agentName: string; instanceId: string; runId: string };
  emit(event: AigentEvent): void;
}

export function createRunEffects(params: CreateRunEffectsParams): RunEffects {
  const { dryRun, log, ids, emit } = params;
  const planned: PlannedEffect[] = [];
  const writes: Promise<void>[] = [];
  return {
    dryRun,
    planned,
    record: ({ envelope: { id: callId }, plannedEffects = [], effects = [] }) => {
      if (plannedEffects.length > 0) {
        planned.push(...plannedEffects);
        emit({ type: 'planned-effects', callId, effects: plannedEffects });
      }
      for (const effect of effects) {
        const write = log?.append({ effect, ...ids }).catch((error: unknown) => emit({ type: 'warning', message: `The effect of call '${effect.callId}' (${effect.tool}) was not recorded, so it cannot be undone: ${error instanceof Error ? error.message : String(error)}` }));
        if (write != null) writes.push(write);
      }
    },
    flush: async () => { await Promise.all(writes); },
  };
}
