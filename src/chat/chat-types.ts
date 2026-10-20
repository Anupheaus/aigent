import type { TaskUsage, StopOptions } from '../core/agent-types.js';
import type { AigentEvent, TaskStatus } from '../core/aigent-events.js';
import type { StreamRun } from '../core/event-stream.js';
import type { ModelSettings } from '../core/model-settings.js';
import type { RunCallbacks, Unsubscribe } from '../core/run-callbacks.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import type { SubscribeOptions, PatchListener } from './apply-patch.js';
import type { Branch, ConversationState, QueuedMessage } from './conversation.js';
import type { DeliveryMode, JsonValue, Message } from './message.js';

/** A file or image sent with a message: given inline (`bytes`/`text`) or by `ref`, read through `readAttachment`. */
export interface AttachmentInput {
  kind: 'image' | 'file';
  /** Read with `ChatOptions.attachments.readAttachment`; core never touches the filesystem itself. */
  ref?: string;
  bytes?: Uint8Array;
  /** Text content (alternative to `bytes`). */
  text?: string;
  name?: string;
  mimeType?: string;
}

/** What `readAttachment` returns for a ref. */
export interface ReadAttachmentResult {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ChatAttachmentOptions {
  /** Resolves `AttachmentInput.ref`; supplied by the consumer (or an fs-policy pack). */
  readAttachment?(ref: string): Promise<ReadAttachmentResult>;
  /** Without provider vision: `'error'` (default) rejects images, `'describe'` sends `describe`'s text instead. */
  onNoVision?: 'error' | 'describe';
  describe?(image: ReadAttachmentResult): Promise<string>;
}

export interface SendInput {
  text: string;
  attachments?: AttachmentInput[];
  /** Opens or continues a thread on that message. */
  replyTo?: string;
  /** False keeps the message verbatim through compaction. Default true. */
  compactable?: boolean;
}

export interface SendOptions {
  /** How the message reaches a busy agent (default: the chat's `whileBusy`). */
  delivery?: DeliveryMode;
  /** `interrupt` only: also abort tools with side effects. */
  force?: boolean;
  /** `queue` only: merge with adjacent queued messages into one turn (default: the chat's `coalesce`). */
  coalesce?: boolean;
  replyTo?: string;
}

export interface ChatReply {
  text: string;
  responseId: string;
  /** The agent message holding the reply. */
  messageId: string;
  usage: TaskUsage;
  status: TaskStatus;
  /** Shortcut for `ai.feedback({ responseId, ...feedback })`. Not enumerable. */
  feedback(feedback: Omit<UserFeedback, 'responseId'>): Promise<void>;
}

/** One reply in progress: iterate its events, await its reply, stop it. */
export type ChatTurn = StreamRun<AigentEvent, ChatReply> & RunCallbacks & {
  /** The agent message the reply streams into (shared by coalesced and steered messages). */
  readonly messageId: string;
  stop(options?: StopOptions): void;
  cancel(): void;
};

export interface ChatOptions {
  /** Reopens a stored session; generated when absent. */
  sessionId?: string;
  /** Default `'store'` when the runtime has a store, else `'memory'` (nothing written). */
  persistence?: 'store' | 'memory';
  /** Background for every turn (the session brief). */
  context?: string;
  constraints?: string[];
  /** No user: `ask_user` is not offered. */
  unattended?: boolean;
  /** Aborting it stops the running turn. */
  signal?: AbortSignal;
  /** Default delivery of messages sent while the agent is busy (default `'queue'`). */
  whileBusy?: DeliveryMode;
  /** Default for `SendOptions.coalesce` (default false). */
  coalesce?: boolean;
  /** Queued and steering messages when a turn is stopped: kept (default) or discarded. */
  onStop?: 'discard' | 'keep';
  modelSettings?: ModelSettings;
  /** One cheap model call after the first exchange names the session (default false). */
  autoTitle?: boolean;
  attachments?: ChatAttachmentOptions;
}

/** Messages waiting for the agent; editable until they start. */
export interface ChatQueue {
  (): QueuedMessage[];
  edit(id: string, text: string): void;
  move(id: string, toIndex: number): void;
  remove(id: string): void;
}

export type AnswerResult = { ok: true } | { ok: false; error: string };

export interface ChatThread {
  rootMessageId: string;
  messages(): Message[];
  /** Appends a summary of the thread (kind `summary`) to the main line. */
  promote(): Message;
}

export interface Chat {
  readonly sessionId: string;
  /** Resolves once a stored session is loaded; every method waits for it on its own. */
  readonly ready: Promise<void>;
  send(input: string | SendInput, options?: SendOptions): ChatTurn;
  conversation(): ConversationState;
  subscribe(listener: PatchListener, options?: SubscribeOptions): Unsubscribe;
  /** The active branch's main line, as the UI shows it. */
  history(): Message[];
  setContext(text: string): void;
  /** Rates a reply (the latest when `responseId` is omitted). */
  feedback(feedback: Omit<UserFeedback, 'responseId'> & { responseId?: string }): Promise<void>;
  react(messageId: string, rating: 'up' | 'down', comment?: string): Promise<void>;
  /** Answers an open question; an invalid answer leaves it open and says precisely why. Throws while a stored session is loading. */
  answer(questionId: string, value: JsonValue): AnswerResult;
  /** The queued messages; `edit`, `move` and `remove` work until a message starts (then they throw `invalid_input`). */
  queue: ChatQueue;
  /** The thread on a message (or the thread it belongs to). */
  thread(messageId: string): ChatThread;
  /** A new session with this one's main line up to `atMessageId` (default: all of it); the two evolve independently. */
  fork(options?: { atMessageId?: string }): Chat;
  /** Every branch, each with its parent and branch point: the tree as a list. */
  branches(): Branch[];
  /** Makes another branch the one the model sees (only while idle). */
  selectBranch(branchId: string): void;
  /** Answers `newText` instead of a user message, on a new branch (the old one is kept). */
  edit(messageId: string, newText: string): ChatTurn;
  /** Answers again on a new branch instead of an agent reply (the old one is kept). */
  regenerate(messageId: string): ChatTurn;
  /** Keeps the message verbatim through compaction (`pinned`, not compactable). */
  pin(messageId: string): void;
  unpin(messageId: string): void;
  /** Lets the running turn finish (a turn waiting for an answer is cancelled; its questions stay open), then flushes writes. */
  close(): Promise<void>;
}
