import type { PatchLog } from './apply-patch.js';
import type { ChatRuntime, ChatSettings } from './chat-turn.js';
import { startChatTurn } from './chat-turn.js';
import type { ChatOptions } from './chat-types.js';
import { historyToProvider } from './history-to-provider.js';
import { lineage } from './lineage.js';
import { userMessage } from './message-builders.js';
import type { MessageDelivery } from './message.js';
import type { TurnHandle, TurnRunControl } from './turn-handle.js';

/** A message on its way to the agent, with the handle `send` returned for it. */
export interface PendingSend {
  userMessageId: string;
  agentMessageId: string;
  text: string;
  /** What the model is sent for it. */
  modelText: string;
  handle: TurnHandle;
  compactable?: boolean;
  queuedAt?: number;
}

/** The reply in progress. */
interface ActiveTurn {
  control: TurnRunControl;
  agentMessageId: string;
}

export interface ChatEngineParams {
  runtime: ChatRuntime;
  log: PatchLog;
  settings: ChatSettings;
  options: ChatOptions;
}

export interface ChatEngine {
  /** Starts the message's turn now, or queues it behind the running one. */
  accept(pending: PendingSend): void;
  /** Resolves once no turn runs and nothing is queued. */
  idle(): Promise<void>;
}

export function createChatEngine(params: ChatEngineParams): ChatEngine {
  const { runtime, log, settings } = params;
  const { clock } = runtime.services;
  const queue: PendingSend[] = [];
  let active: ActiveTurn | undefined;
  let idleWaiters: (() => void)[] = [];

  function setStatus(status: 'idle' | 'running' | 'waiting_for_user'): void {
    if (log.state().status !== status) log.append({ type: 'status-changed', status });
  }

  function publishQueue(): void {
    log.append({ type: 'queue-updated', queue: queue.map(({ userMessageId, text, queuedAt = 0 }) => ({ id: userMessageId, text, queuedAt })) });
  }

  function start(pending: PendingSend): void {
    const { userMessageId, agentMessageId, text, modelText, handle, compactable, queuedAt } = pending;
    const now = clock.now();
    const { branchId } = log.state();
    const delivery: MessageDelivery | undefined = queuedAt == null ? undefined : { mode: 'queue', queuedAt, startedAt: now };
    log.append({ type: 'message-added', message: userMessage({ id: userMessageId, text, modelText, branchId, createdAt: now, ...(delivery == null ? {} : { delivery }), ...(compactable == null ? {} : { compactable }) }) });
    setStatus('running');
    let control: TurnRunControl;
    try {
      const history = historyToProvider(lineage({ state: log.state() }));
      control = startChatTurn({ runtime, log, settings, messageId: agentMessageId, replyTo: userMessageId, branchId, history, taskText: text, interruptedBy: () => undefined });
    } catch (error) {
      // The turn could not start (e.g. invalid settings): its caller hears why, the queue moves on.
      handle.fail(error);
      finished();
      return;
    }
    active = { control, agentMessageId };
    handle.attach(control);
    void control.reply.then(finished, finished);
  }

  function finished(): void {
    active = undefined;
    const next = queue.shift();
    if (next != null) {
      publishQueue();
      start(next);
      return;
    }
    setStatus('idle');
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
  }

  function accept(pending: PendingSend): void {
    if (active == null) { start(pending); return; }
    queue.push({ ...pending, queuedAt: clock.now() });
    publishQueue();
  }

  return {
    accept,
    idle: () => (active == null && queue.length === 0 ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve))),
  };
}
