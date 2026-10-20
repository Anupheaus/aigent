import type { StopOptions } from '../core/agent-types.js';
import type { PatchLog } from './apply-patch.js';
import { createAskUserTool } from './ask-user-tool.js';
import { createChatQuestions } from './chat-questions.js';
import type { ChatQuestions } from './chat-questions.js';
import type { ChatRuntime, ChatSettings } from './chat-turn.js';
import { startChatTurn } from './chat-turn.js';
import { historyToProvider } from './history-to-provider.js';
import { lineage } from './lineage.js';
import { userMessage } from './message-builders.js';
import type { MessageDelivery } from './message.js';
import { createTurnHandle } from './turn-handle.js';
import type { TurnHandle, TurnRunControl } from './turn-handle.js';

/** The user's message a turn answers, added when the turn starts. */
export interface PendingUserMessage {
  id: string;
  text: string;
  /** What the model is sent for it. */
  modelText: string;
  compactable?: boolean;
}

/** A turn on its way: with a user message (a send), or answering what is already there (answered questions). */
export interface PendingTurn {
  agentMessageId: string;
  handle: TurnHandle;
  user?: PendingUserMessage;
  /** Without `user`: the message being answered. */
  replyTo?: string;
  taskText: string;
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
}

export interface ChatEngine {
  /** Starts the turn now, or queues it behind the running one. */
  accept(pending: PendingTurn): void;
  questions: ChatQuestions;
  /** Makes `handle` follow the running turn (a reply that answered its question); false when none runs. */
  followActive(handle: TurnHandle): boolean;
  /** Stops the running turn. */
  stopActive(options: StopOptions): void;
  /** Resolves once no turn runs and nothing is queued. */
  idle(): Promise<void>;
}

export function createChatEngine(params: ChatEngineParams): ChatEngine {
  const { runtime, log, settings } = params;
  const { clock, ids } = runtime.services;
  const now = (): number => clock.now();
  const queue: PendingTurn[] = [];
  let active: ActiveTurn | undefined;
  let idleWaiters: (() => void)[] = [];

  function setStatus(status: 'idle' | 'running' | 'waiting_for_user'): void {
    if (log.state().status !== status) log.append({ type: 'status-changed', status });
  }

  const questions = createChatQuestions({
    log, ids, now, setStatus,
    resumeInFreshTurn: ({ replyTo, taskText, handle: given }) => {
      const agentMessageId = ids.next('msg');
      const handle = given ?? createTurnHandle(agentMessageId);
      handle.setMessageId(agentMessageId);
      accept({ agentMessageId, handle, replyTo, taskText });
      return handle;
    },
  });

  function publishQueue(): void {
    log.append({ type: 'queue-updated', queue: queue.flatMap(({ user, queuedAt = 0 }) => (user == null ? [] : [{ id: user.id, text: user.text, queuedAt }])) });
  }

  function addUserMessage(params: { user: PendingUserMessage; queuedAt?: number }): string {
    const { user: { id, text, modelText, compactable }, queuedAt } = params;
    const createdAt = now();
    const delivery: MessageDelivery | undefined = queuedAt == null ? undefined : { mode: 'queue', queuedAt, startedAt: createdAt };
    log.append({ type: 'message-added', message: userMessage({ id, text, modelText, branchId: log.state().branchId, createdAt, ...(delivery == null ? {} : { delivery }), ...(compactable == null ? {} : { compactable }) }) });
    return id;
  }

  function start(pending: PendingTurn): void {
    const { agentMessageId, handle, user, taskText, queuedAt } = pending;
    const replyTo = user == null ? pending.replyTo ?? '' : addUserMessage({ user, ...(queuedAt == null ? {} : { queuedAt }) });
    setStatus('running');
    const { branchId } = log.state();
    let control: TurnRunControl;
    try {
      const history = historyToProvider(lineage({ state: log.state() }));
      const tools = settings.unattended === true ? [] : [createAskUserTool(questions.askFor({ agentMessageId, branchId }))];
      control = startChatTurn({ runtime, log, settings, messageId: agentMessageId, replyTo, branchId, history, taskText, tools, interruptedBy: () => undefined });
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

  function accept(pending: PendingTurn): void {
    if (active == null) { start(pending); return; }
    queue.push({ ...pending, queuedAt: now() });
    publishQueue();
  }

  function followActive(handle: TurnHandle): boolean {
    if (active == null) return false;
    handle.setMessageId(active.agentMessageId);
    handle.attach(active.control);
    return true;
  }

  return {
    accept,
    questions,
    followActive,
    stopActive: options => active?.control.stop(options),
    idle: () => (active == null && queue.length === 0 ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve))),
  };
}
