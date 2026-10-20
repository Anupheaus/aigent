import type { ActivityUpdate } from './activity-update.js';
import type { AigentEvent } from './aigent-events.js';
import { createEventStream } from './event-stream.js';
import type { EventStream, StreamRun } from './event-stream.js';

/** Where a model turn's reasoning came from. */
export interface ThinkingContext {
  runId: string;
  /** 1-based model request of the run. */
  turn: number;
  /** The chat's agent message, for chat turns. */
  messageId?: string;
}

export type ToolActivityEvent = Extract<AigentEvent, { type: 'tool-activity' }>;
export type Unsubscribe = () => void;

/** Callback views of a run's events: each sees exactly the events (earlier ones replayed), in order. */
export interface RunCallbacks {
  onActivity(listener: (update: ActivityUpdate) => void): Unsubscribe;
  /** Called once per model turn that streams reasoning, with that turn's deltas as they arrive. */
  onThinking(listener: (thinking: AsyncIterable<string>, context: ThinkingContext) => void): Unsubscribe;
  onToolActivity(listener: (event: ToolActivityEvent) => void): Unsubscribe;
}

/** Feeds every event to `handle` until unsubscribed; consumer errors never reach the run. */
function follow(params: { run: AsyncIterable<AigentEvent>; handle(event: AigentEvent): void }): Unsubscribe {
  const { run, handle } = params;
  let isActive = true;
  void (async () => {
    for await (const event of run) {
      if (!isActive) return;
      try {
        handle(event);
      } catch {
        // A listener's failure is the consumer's; the run and the other listeners carry on.
      }
    }
  })().catch(() => undefined);
  return () => { isActive = false; };
}

function followThinking(params: { run: AsyncIterable<AigentEvent>; context(): Omit<ThinkingContext, 'turn'>; listener: Parameters<RunCallbacks['onThinking']>[0] }): Unsubscribe {
  const { run, context, listener } = params;
  let turn = 1;
  let current: EventStream<string, void> | undefined;
  return follow({
    run,
    handle: event => {
      if (event.type === 'usage') turn += 1;
      if (event.type === 'thinking-delta') {
        if (current == null) { current = createEventStream<string, void>(); listener(current.run, { ...context(), turn }); }
        current.push(event.text);
      }
      if ((event.type === 'thinking-done' || event.type === 'done') && current != null) { current.finish(); current = undefined; }
    },
  });
}

/** `context` is read when a thinking stream starts (a chat turn learns its run id only once it starts). */
export function createRunCallbacks(params: { run: StreamRun<AigentEvent, unknown>; context(): Omit<ThinkingContext, 'turn'> }): RunCallbacks {
  const { run, context } = params;
  return {
    onActivity: listener => follow({ run, handle: event => { if (event.type === 'activity') listener(event.update); } }),
    onThinking: listener => followThinking({ run, context, listener }),
    onToolActivity: listener => follow({ run, handle: event => { if (event.type === 'tool-activity') listener(event); } }),
  };
}
