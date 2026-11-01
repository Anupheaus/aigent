import type { StopOptions } from '../core/agent-types.js';
import type { PatchLog } from './apply-patch.js';
import type { ChatQuestions } from './chat-questions.js';
import type { ChatRuntime, ChatSettings } from './chat-turn.js';
import type { QueuedMessage } from './conversation.js';
import type { PendingTurn } from './pending-turn.js';
import type { SteerInbox } from './steer-inbox.js';
import type { SuspendedTurns } from './suspended-turns.js';
import type { TurnHandle, TurnRunControl } from './turn-handle.js';

/** The reply in progress. */
export interface ActiveTurn {
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
