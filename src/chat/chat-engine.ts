import type { StopOptions } from '../core/agent-types.js';
import type { PatchLog } from './apply-patch.js';
import { createAskUserTool } from './ask-user-tool.js';
import { closedError } from './chat-closed.js';
import { createEngineQuestions } from './engine-questions.js';
import type { ChatQuestions } from './chat-questions.js';
import type { ApprovalChange, ChatRuntime, ChatSettings } from './chat-turn.js';
import { startChatTurn } from './chat-turn.js';
import type { QueuedMessage } from './conversation.js';
import { routeDelivery } from './delivery.js';
import { historyToProvider } from './history-to-provider.js';
import { lineage } from './lineage.js';
import { moveQueued, queuedMessages, removeQueued, takeNext } from './message-queue.js';
import { editPendingText, settleCancelled } from './pending-turn.js';
import { requeue } from './requeue.js';
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
  /** What handles attach to: `stop` through it is a user stop, so `onStop` applies. */
  handleControl: TurnRunControl;
  /** Messages steered into this turn so far. */
  steered: Set<string>;
  /** Set at the user's stop: the queued and steered messages `onStop: 'discard'` drops. */
  discard?: ReadonlySet<string>;
  agentMessageId: string;
  threadId?: string;
  inbox: SteerInbox<PendingTurn>;
  interruptedBy?: string;
  /** Stopped through its handle (not by an interrupt or close): `onStop` applies. */
  isStoppedByUser: boolean;
  /** Approval requests the turn is waiting on: nobody may answer them while the chat closes. */
  pendingApprovals: Set<string>;
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
  /**
   * Closes the engine for good: a waiting turn is stopped, a turn that asks later is stopped as it asks, queued messages
   * are settled `cancelled` instead of starting, and new messages are refused.
   */
  close(): void;
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
  let isClosing = false;

  function setStatus(status: 'idle' | 'running' | 'waiting_for_user'): void {
    if (log.state().status !== status) log.append({ type: 'status-changed', status });
  }

  const questions = createEngineQuestions({ log, ids, now, setStatus, accept: pending => accept(pending), activeControl: () => active?.control, isClosing: () => isClosing, ...(suspended == null ? {} : { suspended }) });

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
    const turn: { control?: TurnRunControl; current?: ActiveTurn } = {};
    const onApproval = (change: ApprovalChange): void => {
      const { current } = turn;
      if (current == null) return;
      if (change.kind === 'decided') { current.pendingApprovals.delete(change.requestId); return; }
      current.pendingApprovals.add(change.requestId);
      // The request survives a restart: a reopened session restores it and continues the turn once it is decided.
      suspended?.suspend({ runId: current.control.streamId ?? current.control.runId, callId: change.callId, agentMessageId, approvalRequestId: change.requestId, patchSeq: log.state().seq });
      if (isClosing) current.control.stop({ mode: 'immediate' });
    };
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
        interruptedBy: () => active?.interruptedBy, ...(last.restore == null ? {} : { restore: last.restore }), onApproval,
      });
    } catch (error) {
      // The turn could not start (e.g. invalid settings): its callers hear why, the queue moves on.
      for (const { handle } of entries) handle.fail(error);
      finished(false);
      return;
    }
    const current: ActiveTurn = { control, handleControl: control, steered: new Set(), agentMessageId, inbox, isStoppedByUser: false, pendingApprovals: new Set(), ...(threadId == null ? {} : { threadId }) };
    turn.current = current;
    const userStop: TurnRunControl = {
      ...control,
      stop: options => {
        current.isStoppedByUser = true;
        current.discard ??= new Set([...queue.map(({ agentMessageId: id }) => id), ...current.steered]);
        control.stop(options);
      },
    };
    current.handleControl = userStop;
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
    const discard = ended?.isStoppedByUser === true && onStop === 'discard' ? ended.discard : undefined;
    const { queue: kept, dropped } = requeue({ leftovers, queue, ...(discard == null ? {} : { discard }), now: now() });
    queue = kept;
    if (leftovers.length > 0 || dropped.length > 0) publishQueue();
    for (const pending of dropped) settleCancelled(pending);
    if (ended != null && !isClosing) afterReply?.();
    if (isClosing) settleQueue();
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

  /** Settles every queued message `cancelled` (closing: nothing more starts). */
  function settleQueue(): void {
    if (queue.length === 0) return;
    const settled = queue;
    queue = [];
    publishQueue();
    for (const pending of settled) settleCancelled(pending);
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
    if (isClosing) { pending.handle.fail(closedError(log.state().sessionId)); return; }
    pending.handle.onEarlyStop(() => cancelEarly(pending));
    const running = active;
    const action = routeDelivery({ mode: pending.delivery ?? 'queue', isBusy: running != null, hasQueue: queue.length > 0 });
    if (action === 'start') { start([pending]); return; }
    // A thread turn and a main-line turn never steer each other: such a message waits its turn.
    if (action === 'steer' && running != null && running.threadId === pending.threadId) { running.inbox.push(pending); running.steered.add(pending.agentMessageId); return; }
    if (action === 'interrupt' && running != null) { interrupt({ pending, running }); return; }
    enqueue(pending);
  }

  function changeQueue(change: (current: PendingTurn[]) => PendingTurn[]): void {
    queue = change(queue);
    publishQueue();
  }

  return {
    accept,
    queue: {
      list: () => queuedMessages(queue),
      edit: (id, text) => changeQueue(current => editPendingText({ queue: current, id, text, startedIds: startedIds() })),
      move: (id, toIndex) => changeQueue(current => moveQueued({ queue: current, id, toIndex, startedIds: startedIds() })),
      remove: id => { const { queue: rest, removed } = removeQueued({ queue, id, startedIds: startedIds() }); queue = rest; publishQueue(); settleCancelled(removed); },
    },
    questions,
    followActive: handle => {
      if (active == null) return false;
      handle.setMessageId(active.agentMessageId);
      handle.attach(active.handleControl);
      return true;
    },
    stopActive: options => active?.control.stop(options),
    close: () => {
      isClosing = true;
      // Without a running turn nothing calls finished(): the queue is settled here.
      if (active == null) settleQueue();
      // A turn waiting for a person (questions or approvals) would hold close open forever: it is stopped, and stays
      // suspended in its checkpoints when the session is stored.
      else if (log.state().status === 'waiting_for_user' || active.pendingApprovals.size > 0) active.control.stop({ mode: 'immediate' });
    },
    idle: () => (active == null && queue.length === 0 ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve))),
  };
}
