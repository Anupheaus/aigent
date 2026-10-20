import type { StopOptions } from '../core/agent-types.js';
import type { AigentEvent } from '../core/aigent-events.js';
import { createEventStream } from '../core/event-stream.js';
import { createRunCallbacks } from '../core/run-callbacks.js';
import type { ChatReply, ChatTurn } from './chat-types.js';

/** What a handle drives once its turn has started. */
export interface TurnRunControl {
  runId: string;
  /** The checkpoint stream the run writes to (the suspended run's when it continues one); default `runId`. */
  streamId?: string;
  events: AsyncIterable<AigentEvent>;
  /** The run's thinking channel (reasoning even when `showThinking` hides it from `events`). */
  thinking?: AsyncIterable<AigentEvent>;
  /** The run's primary provider and model, for `onThinking`'s context. */
  source?: { provider: string; model: string };
  reply: Promise<ChatReply>;
  stop(options?: StopOptions): void;
}

export interface TurnHandle {
  turn: ChatTurn;
  /** Pipes a started turn's events and reply into the handle. */
  attach(control: TurnRunControl): void;
  /** Settles the handle without a run (stopped before it started, or the turn could not start). */
  settle(reply: ChatReply): void;
  fail(error: unknown): void;
  /** Coalesced and steered messages are answered in another message. */
  setMessageId(messageId: string): void;
  /** A stop asked for before the turn started; the engine decides what it means. */
  onEarlyStop(listener: (options: StopOptions) => void): void;
}

/** A turn handle that exists before its run does (queued messages), so `send` can always return at once. */
export function createTurnHandle(messageId: string): TurnHandle {
  const stream = createEventStream<AigentEvent, ChatReply>();
  const thinking = createEventStream<AigentEvent, void>();
  let currentMessageId = messageId;
  let control: TurnRunControl | undefined;
  let isSettled = false;
  let earlyStop: ((options: StopOptions) => void) | undefined;

  function finish(reply: ChatReply): void {
    if (isSettled) return;
    isSettled = true;
    stream.finish(reply);
  }

  function pipeThinking(source: AsyncIterable<AigentEvent> | undefined): void {
    if (source == null) { thinking.finish(); return; }
    void (async () => { for await (const event of source) thinking.push(event); })().catch(() => undefined).finally(() => thinking.finish());
  }

  function attach(started: TurnRunControl): void {
    control = started;
    const { events, reply } = started;
    pipeThinking(started.thinking);
    void (async () => {
      for await (const event of events) stream.push(event);
      finish(await reply);
    })().catch(error => { if (!isSettled) { isSettled = true; stream.fail(error); } });
  }

  function stop(options: StopOptions = {}): void {
    if (isSettled) return;
    if (control != null) { control.stop(options); return; }
    earlyStop?.(options);
  }

  const callbacks = createRunCallbacks({ run: stream.run, thinking: thinking.run, context: () => ({ runId: control?.runId ?? '', messageId: currentMessageId, ...control?.source }) });
  const turn = Object.assign(stream.run, { stop, cancel: () => stop({ mode: 'immediate' }), ...callbacks }) as ChatTurn;
  Object.defineProperty(turn, 'messageId', { get: () => currentMessageId, enumerable: true });
  return {
    turn,
    attach,
    settle: reply => { thinking.finish(); finish(reply); },
    fail: error => { thinking.finish(); if (!isSettled) { isSettled = true; stream.fail(error); } },
    setMessageId: id => { currentMessageId = id; },
    onEarlyStop: listener => { earlyStop = listener; },
  };
}
