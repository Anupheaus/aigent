import type { StopOptions } from '../core/agent-types.js';
import type { PatchLog } from './apply-patch.js';
import { createAskUserTool } from './ask-user-tool.js';
import { createEngineQuestions } from './engine-questions.js';
import type { ChatQuestions } from './chat-questions.js';
import type { ChatRuntime, ChatSettings } from './chat-turn.js';
import { startChatTurn } from './chat-turn.js';
import type { QueuedMessage } from './conversation.js';
import { routeDelivery } from './delivery.js';
import { historyToProvider } from './history-to-provider.js';
import { lineage } from './lineage.js';
import { editQueued, moveQueued, queuedMessages, removeQueued, takeNext } from './message-queue.js';
import { settleCancelled } from './pending-turn.js';
import { recordSteered, recordUserMessage } from './user-messages.js';
import type { PendingTurn } from './pending-turn.js';
import { createSteerInbox } from './steer-inbox.js';
import type { SteerInbox } from './steer-inbox.js';
import { threadContext, threadWith } from './threads.js';
import type { SuspendedTurns } from './suspended-turns.js';
import type { TurnHandle, TurnRunControl } from './turn-handle.js';

/** The reply in progress. */
interface ActiveTurn {
  control: TurnRunControl;
  agentMessageId: string;
  threadId?: string;
  inbox: SteerInbox<PendingTurn>;
  interruptedBy?: string;
  /** Stopped through its handle (not by an interrupt or close): `onStop` applies. */
  isStoppedByUser: boolean;
}

export interface ChatEngineParams {
  runtime: ChatRuntime;
  log: PatchLog;
  settings: ChatSettings;
  /** Queued and steering messages when a turn is stopped through its handle (default keep). */
  onStop?: 'discard' | 'keep';
  /** Called after each finished reply (e.g. to title the session). */
  afterReply?(): void;
  /** With checkpoints: turns suspended in `ask_user`, continued when their questions are answered after a restart. */
  suspended?: SuspendedTurns;
}

export interface ChatEngine {
  /** Routes a message by its delivery: start now, queue, steer into or interrupt the running turn. */
  accept(pending: PendingTurn): void;
  queue: { list(): QueuedMessage[]; edit(id: string, text: string): void; move(id: string, toIndex: number): void; remove(id: string): void };
  questions: ChatQuestions;
  /** Makes `handle` follow the running turn; false when none runs. */
  followActive(handle: TurnHandle): boolean;
  /** Stops the running turn (as close does: `onStop` does not apply). */
  stopActive(options: StopOptions): void;
  /** Resolves once no turn runs and nothing is queued. */
  idle(): Promise<void>;
}

export function createChatEngine(params: ChatEngineParams): ChatEngine {
  const { runtime, log, settings, onStop = 'keep', afterReply, suspended } = params;
  const { clock, ids } = runtime.services;
  const now = (): number => clock.now();
  let queue: PendingTurn[] = [];
  let active: ActiveTurn | undefined;
  let idleWaiters: (() => void)[] = [];

  function setStatus(status: 'idle' | 'running' | 'waiting_for_user'): void {
    if (log.state().status !== status) log.append({ type: 'status-changed', status });
  }

  const questions = createEngineQuestions({ log, ids, now, setStatus, accept: pending => accept(pending), activeControl: () => active?.control, ...(suspended == null ? {} : { suspended }) });

  const publishQueue = (): void => { log.append({ type: 'queue-updated', queue: queuedMessages(queue) }); };
  const startedIds = (): ReadonlySet<string> => new Set(log.state().messages.map(({ id }) => id));

  function start(entries: PendingTurn[]): void {
    const [head] = entries;
    const last = entries.at(-1);
    if (head == null || last == null) return;
    for (const pending of entries) recordUserMessage({ log, pending, now: now() });
    setStatus('running');
    const { agentMessageId } = head;
    const { threadId, taskText } = last;
    const replyTo = last.user?.id ?? last.replyTo ?? '';
    const { branchId } = log.state();
    if (threadId != null) log.append({ type: 'thread-updated', thread: threadWith({ state: log.state(), rootMessageId: threadId, messageIds: [...entries.flatMap(({ user }) => (user == null ? [] : [user.id])), agentMessageId], at: now() }) });
    const turn: { control?: TurnRunControl } = {};
    const inbox = createSteerInbox<PendingTurn>({
      toMessage: pending => ({ role: 'user', text: pending.user?.modelText ?? pending.taskText }),
      onDeliver: delivered => { if (turn.control != null) recordSteered({ log, now, control: turn.control, agentMessageId, delivered }); },
    });
    let control: TurnRunControl;
    try {
      const state = log.state();
      const history = threadId == null ? historyToProvider(lineage({ state })) : threadContext({ state, rootMessageId: threadId });
      const tools = settings.unattended === true ? [] : [createAskUserTool(questions.askFor({ agentMessageId, branchId, ...(threadId == null ? {} : { threadId }) }))];
      control = startChatTurn({
        runtime, log, settings, messageId: agentMessageId, replyTo, branchId, history, taskText, tools, steer: inbox, ...(threadId == null ? {} : { threadId }),
        interruptedBy: () => active?.interruptedBy, ...(last.restore == null ? {} : { restore: last.restore }),
      });
    } catch (error) {
      // The turn could not start (e.g. invalid settings): its callers hear why, the queue moves on.
      for (const { handle } of entries) handle.fail(error);
      finished(false);
      return;
    }
    const current: ActiveTurn = { control, agentMessageId, inbox, isStoppedByUser: false, ...(threadId == null ? {} : { threadId }) };
    const userStop: TurnRunControl = { ...control, stop: options => { current.isStoppedByUser = true; control.stop(options); } };
    turn.control = userStop;
    active = current;
    for (const { handle } of entries) { handle.setMessageId(agentMessageId); handle.attach(userStop); }
    void control.reply.then(({ status }) => finished(status === 'cancelled'), () => finished(false));
  }

  function finished(wasCancelled: boolean): void {
    const ended = active;
    active = undefined;
    // Steering that arrived after the last model request was never delivered: it waits in the queue instead.
    const leftovers = ended?.inbox.drain() ?? [];
    if (ended?.isStoppedByUser === true && onStop === 'discard') {
      for (const pending of [...leftovers, ...queue]) settleCancelled(pending);
      queue = [];
      publishQueue();
    } else if (leftovers.length > 0) {
      queue.push(...leftovers.map(pending => ({ ...pending, queuedAt: pending.queuedAt ?? now() })));
      publishQueue();
    }
    if (ended != null) afterReply?.();
    const { taken, rest } = takeNext(queue);
    if (taken.length > 0) {
      queue = rest;
      publishQueue();
      const interruptedBy = wasCancelled ? ended?.interruptedBy : undefined;
      start(taken.map(pending => (pending.delivery === 'interrupt' ? { ...pending, interrupted: interruptedBy != null && interruptedBy === pending.user?.id } : pending)));
      return;
    }
    setStatus('idle');
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
  }

  function enqueue(pending: PendingTurn): void {
    queue.push({ ...pending, queuedAt: now() });
    publishQueue();
  }

  function interrupt(params: { pending: PendingTurn; running: ActiveTurn }): void {
    const { pending, running } = params;
    // Behind earlier interrupts, ahead of everything else queued.
    const position = queue.findIndex(({ delivery }) => delivery !== 'interrupt');
    queue.splice(position === -1 ? queue.length : position, 0, { ...pending, queuedAt: now() });
    publishQueue();
    if (running.interruptedBy == null && pending.user != null) running.interruptedBy = pending.user.id;
    running.control.stop({ mode: 'immediate', ...(pending.force === true ? { force: true } : {}) });
  }

  function cancelEarly(pending: PendingTurn): void {
    const index = queue.findIndex(({ agentMessageId }) => agentMessageId === pending.agentMessageId);
    if (index !== -1) { queue.splice(index, 1); publishQueue(); }
    settleCancelled(pending);
  }

  function accept(pending: PendingTurn): void {
    pending.handle.onEarlyStop(() => cancelEarly(pending));
    const running = active;
    const action = routeDelivery({ mode: pending.delivery ?? 'queue', isBusy: running != null, hasQueue: queue.length > 0 });
    if (action === 'start') { start([pending]); return; }
    // A thread turn and a main-line turn never steer each other: such a message waits its turn.
    if (action === 'steer' && running != null && running.threadId === pending.threadId) { running.inbox.push(pending); return; }
    if (action === 'interrupt' && running != null) { interrupt({ pending, running }); return; }
    enqueue(pending);
  }

  /** What follows a queued message's own text in the model's view (its attachments), kept across an edit. */
  function modelSuffix(params: { queue: PendingTurn[]; id: string }): string {
    const user = params.queue.find(entry => entry.user?.id === params.id)?.user;
    return user == null ? '' : user.modelText.slice(user.text.length);
  }

  function changeQueue(change: (current: PendingTurn[]) => PendingTurn[]): void {
    queue = change(queue);
    publishQueue();
  }

  return {
    accept,
    queue: {
      list: () => queuedMessages(queue),
      edit: (id, text) => changeQueue(current => editQueued({ queue: current, id, text, startedIds: startedIds() }).map(entry => (entry.user?.id === id ? { ...entry, taskText: text, user: { ...entry.user, modelText: text + modelSuffix({ queue: current, id }) } } : entry))),
      move: (id, toIndex) => changeQueue(current => moveQueued({ queue: current, id, toIndex, startedIds: startedIds() })),
      remove: id => { const { queue: rest, removed } = removeQueued({ queue, id, startedIds: startedIds() }); queue = rest; publishQueue(); settleCancelled(removed); },
    },
    questions,
    followActive: handle => {
      if (active == null) return false;
      handle.setMessageId(active.agentMessageId);
      handle.attach(active.control);
      return true;
    },
    stopActive: options => active?.control.stop(options),
    idle: () => (active == null && queue.length === 0 ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve))),
  };
}
