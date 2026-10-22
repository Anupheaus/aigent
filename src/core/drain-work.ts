import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { addErrorDetails } from '../tools/tool-error-detail.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { AigentEvent } from './aigent-events.js';
import type { TurnWork } from './run-turn.js';
import { settleActivities } from './settle-activities.js';

/** How long a turn waits, after its tools finished, for activity renderers to settle before abandoning them. */
const ACTIVITY_SETTLE_GRACE_MS = 1_000;

export interface DrainWorkParams {
  work: TurnWork;
  signal: AbortSignal;
  emit(event: AigentEvent): void;
}

/** A turn's work with nothing dispatched yet. */
export function createTurnWork(): TurnWork {
  return { partial: { visible: '', raw: '', calls: [], delegatedCallIds: [], thinkingBlocks: [] }, executions: [], activities: [], activityController: new AbortController() };
}

/**
 * Waits for everything a turn started. Executions race the run's signal (tools in `runTool`, cache lookups and the
 * flights they wait on in `boundedLookup`; a miss always releases its flight) and activity renderers are bounded by
 * `settleActivities`, so this always settles promptly, even after an abort or with a renderer that never finishes.
 * Tools with side effects race their own signal, so after an unforced stop they are awaited until they finish.
 */
export async function drainWork(params: DrainWorkParams): Promise<ExecutedToolCall[]> {
  const { work, signal, emit } = params;
  const { executions, activities, activityController } = work;
  const executed = await Promise.all(executions);
  const isSettled = await settleActivities({ activities, signal, graceMs: ACTIVITY_SETTLE_GRACE_MS });
  if (!isSettled) {
    activityController.abort();
    // After an abort, cutting renderers off is expected rather than a problem worth reporting.
    if (!signal.aborted) emit({ type: 'warning', message: `Tool activity renderers for this turn (${activities.length} started) did not settle within ${ACTIVITY_SETTLE_GRACE_MS} ms after their tools finished; their activity updates were stopped` });
  }
  return executed;
}

/**
 * Every failure of a turn: failed calls, plus failures nested inside successful aggregate results (batch items,
 * aigent_multi calls), taken from the full results so a truncated result never hides one.
 */
export function failedDetails(executed: ExecutedToolCall[]): ToolErrorDetail[] {
  return executed.flatMap(({ envelope, nested }) => {
    if (!envelope.ok) return [envelope.error];
    return nested.map(detail => addErrorDetails(detail, { parentCallId: envelope.id }));
  });
}
