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
  /** Set once the publisher exists (it publishes through `push`). */
  activity(): ActivityPublisher | undefined;
}

/** The run's single event path: `thinking-done` after each streamed reasoning, then activity derived from every event. */
export function createRunEmitter(params: CreateRunEmitterParams): RunEmitter {
  const { push, activity } = params;
  let thinking: string | undefined;

  function endThinking(): void {
    if (thinking == null) return;
    const text = thinking;
    thinking = undefined;
    push({ type: 'thinking-done', text });
  }

  function emit(event: AigentEvent): void {
    if (event.type === 'thinking-delta') thinking = (thinking ?? '') + event.text;
    else endThinking();
    push(event);
    activity()?.observe(event);
  }

  return { emit, endThinking };
}
