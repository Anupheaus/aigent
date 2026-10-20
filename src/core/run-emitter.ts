import type { ActivityPublisher } from './activity.js';
import type { AigentEvent } from './aigent-events.js';

export interface RunEmitter {
  /** Pushes the event (closing a finished thinking stream first) and feeds it to the activity publisher. */
  emit(event: AigentEvent): void;
  /** Closes a thinking stream still open when the run ends. */
  endThinking(): void;
}

export interface CreateRunEmitterParams {
  push(event: AigentEvent): void;
  /** `showThinking`: whether reasoning (`thinking-delta` / `thinking-done`) also reaches `push`. */
  showThinking: boolean;
  /** Gets every reasoning event (and `usage`, which ends a model turn) whatever `showThinking` says: `onThinking`'s source. */
  pushThinking(event: AigentEvent): void;
  /** Set once the publisher exists (it publishes through `push`). */
  activity(): ActivityPublisher | undefined;
}

/**
 * The run's single event path: `thinking-done` after each streamed reasoning, then activity derived from every event.
 * Reasoning always goes to the thinking channel; `showThinking` only decides whether the user's stream gets it too.
 */
export function createRunEmitter(params: CreateRunEmitterParams): RunEmitter {
  const { push, activity, showThinking, pushThinking } = params;
  let thinking: string | undefined;

  function endThinking(): void {
    if (thinking == null) return;
    const text = thinking;
    thinking = undefined;
    const done: AigentEvent = { type: 'thinking-done', text };
    pushThinking(done);
    if (showThinking) push(done);
  }

  function emit(event: AigentEvent): void {
    const isThinking = event.type === 'thinking-delta';
    if (isThinking) thinking = (thinking ?? '') + event.text;
    else endThinking();
    if (isThinking || event.type === 'usage') pushThinking(event);
    if (!isThinking || showThinking) push(event);
    activity()?.observe(event);
  }

  return { emit, endThinking };
}
