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
  /** The run's primary provider id. */
  provider?: string;
  /** The run's primary model (without the provider prefix). */
  model?: string;
}

export type ToolActivityEvent = Extract<AigentEvent, { type: 'tool-activity' }>;
export type Unsubscribe = () => void;

/** Callback views of a run's events: each sees exactly the events (earlier ones replayed), in order. */
export interface RunCallbacks {
  onActivity(listener: (update: ActivityUpdate) => void): Unsubscribe;
  /** Called once per model turn that streams reasoning, with that turn's deltas as they arrive (whatever `showThinking` says). */
  onThinking(listener: (thinking: AsyncIterable<string>, context: ThinkingContext) => void): Unsubscribe;
  onToolActivity(listener: (event: ToolActivityEvent) => void): Unsubscribe;
}

/** Where `onThinking` reads from: reasoning and `usage` events, independent of what the user's stream shows. */
const THINKING_CHANNEL = Symbol('aigent.thinking');

/** Attaches a run's thinking channel to its handle (not enumerable, not part of the public type). */
export function withThinkingChannel<T extends object>(params: { run: T; thinking: AsyncIterable<AigentEvent> }): T {
  const { run, thinking } = params;
  return Object.defineProperty(run, THINKING_CHANNEL, { value: thinking, enumerable: false });
}

/** The thinking channel of a run built by `startAgentRun`. */
export function thinkingChannelOf(run: object): AsyncIterable<AigentEvent> | undefined {
  return (run as Partial<Record<typeof THINKING_CHANNEL, AsyncIterable<AigentEvent>>>)[THINKING_CHANNEL];
}

/** Feeds every event to `handle` until unsubscribed, then calls `onEnd`; consumer errors never reach the run. */
function follow(params: { run: AsyncIterable<AigentEvent>; handle(event: AigentEvent): void; onEnd?(): void }): Unsubscribe {
  const { run, handle, onEnd } = params;
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
  })().catch(() => undefined).finally(() => onEnd?.());
  return () => { isActive = false; };
}

function followThinking(params: { run: AsyncIterable<AigentEvent>; context(): Omit<ThinkingContext, 'turn'>; listener: Parameters<RunCallbacks['onThinking']>[0] }): Unsubscribe {
  const { run, context, listener } = params;
  let turn = 1;
  let current: EventStream<string, void> | undefined;
  return follow({
    run,
    // A run that failed mid-reasoning still ends the listener's stream.
    onEnd: () => { current?.finish(); current = undefined; },
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

/**
 * `context` is read when a thinking stream starts (a chat turn learns its run id only once it starts); `thinking` is
 * the run's thinking channel, which carries reasoning even when the user's stream hides it.
 */
export function createRunCallbacks(params: { run: StreamRun<AigentEvent, unknown>; thinking: AsyncIterable<AigentEvent>; context(): Omit<ThinkingContext, 'turn'> }): RunCallbacks {
  const { run, thinking, context } = params;
  return {
    onActivity: listener => follow({ run, handle: event => { if (event.type === 'activity') listener(event.update); } }),
    onThinking: listener => followThinking({ run: thinking, context, listener }),
    onToolActivity: listener => follow({ run, handle: event => { if (event.type === 'tool-activity') listener(event); } }),
  };
}
