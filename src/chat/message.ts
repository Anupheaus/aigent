import type { PlanItemState, TodoItem } from '../planning/plan-schema.js';
import type { FinishReason, ProviderMessage } from '../providers/provider-types.js';

/** Any value that survives `JSON.stringify` / `JSON.parse` unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One renderable piece of a message. Every part is plain JSON. */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'code'; language?: string; text: string }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'image'; attachmentId: string; alt?: string }
  | { type: 'file'; attachmentId: string; name: string }
  | { type: 'question'; questionId: string }
  | { type: 'card'; data: JsonValue }
  | { type: 'tool_call'; callId: string; name: string; argsSummary: string }
  | { type: 'tool_result'; callId: string; ok: boolean; summary: string }
  | { type: 'thinking'; text: string }
  | { type: 'plan'; items: PlanItemState[] }
  | { type: 'todo'; items: TodoItem[] };

export type ChatRole = 'user' | 'agent' | 'system' | 'tool';

export type MessageKind = 'statement' | 'question' | 'answer' | 'status' | 'error' | 'tool_activity' | 'summary' | 'feedback_request' | 'thinking';

export type MessageState = 'streaming' | 'complete' | 'cancelled' | 'failed';

/** How a user message reached the agent while it was busy. */
export type DeliveryMode = 'queue' | 'steer' | 'interrupt';

export interface MessageDelivery {
  mode: DeliveryMode;
  /** Epoch ms when it entered the queue (queued messages only). */
  queuedAt?: number;
  /** Epoch ms when the agent started working on it. */
  startedAt?: number;
  /** It interrupted the agent's previous reply. */
  interrupted?: boolean;
  /** It was injected into a running turn at a safe boundary. */
  steered?: boolean;
}

export interface MessageTokens {
  input: number;
  output: number;
  cached: number;
  reasoning?: number;
}

export interface MessageTiming {
  /** Epoch ms when the run started. */
  startedAt: number;
  firstTokenMs?: number;
  totalMs: number;
  /** Sum of the top-level tool calls' durations, as on the run record. */
  toolMs: number;
}

/** A stored attachment as a message refers to it. */
export interface MessageAttachment {
  /** `att_<sha256>`: the content hash, so identical content is stored once. */
  id: string;
  kind: 'image' | 'file';
  name: string;
  mimeType: string;
  bytes: number;
  /** True when the text was inlined into the model's view of the message. */
  inline: boolean;
  /** One line telling the model what the attachment is when it is referenced by handle. */
  summary: string;
}

export interface QuestionMeta {
  questionId: string;
  type: QuestionType;
  answered: boolean;
  /** The answer, once given (so a resumed turn can hand it to the model as the call's result). */
  answer?: JsonValue;
  /** The `ask_user` call that asked it. */
  callId: string;
}

/** What a UI needs about a message besides its parts; the figures match the run record of the same run. */
export interface MessageMeta {
  agentName?: string;
  instanceId?: string;
  runId?: string;
  responseId?: string;
  provider?: string;
  model?: string;
  tokens?: MessageTokens;
  costUsd?: number;
  timing?: MessageTiming;
  toolCalls?: number;
  cacheHits?: number;
  finishReason?: FinishReason;
  attachments?: MessageAttachment[];
  questionMeta?: QuestionMeta;
  /** On an answer message: the question it answers. */
  answeredQuestionId?: string;
  /** On a question message: the answer message, once answered. */
  answerMessageId?: string;
  userRating?: 'up' | 'down';
  truncated?: boolean;
  error?: string;
  /** Exactly what the model saw for this message (agent replies: the whole turn group, tool rounds included). */
  history?: ProviderMessage[];
}

export interface Message {
  id: string;
  /** The conversation `seq` of the patch that added it. */
  seq: number;
  role: ChatRole;
  kind: MessageKind;
  parts: Part[];
  replyTo?: string;
  threadId?: string;
  branchId: string;
  state: MessageState;
  createdAt: number;
  completedAt?: number;
  delivery?: MessageDelivery;
  pinned: boolean;
  /** False keeps the message verbatim through compaction (questions, answers, pinned messages). */
  compactable: boolean;
  meta: MessageMeta;
}

/** Every question type `ask_user` supports. */
export const QUESTION_TYPES = ['text', 'single_choice', 'multi_choice', 'confirm', 'number'] as const;

export type QuestionType = typeof QUESTION_TYPES[number];

export interface QuestionOption {
  value: string;
  label: string;
}

/** One question the agent asks through `ask_user`. */
export interface Question {
  /** 1 to 40 characters, unique within its batch. */
  id: string;
  text: string;
  type: QuestionType;
  /** Choice types only: 2 to 20 options. */
  options?: QuestionOption[];
  default?: JsonValue;
  required: boolean;
  /** Number: smallest value; text: shortest length; multi_choice: fewest choices. */
  min?: number;
  /** Number: largest value; text: longest length; multi_choice: most choices. */
  max?: number;
}

/** The text of every `text` part, joined. */
export function messageText(message: Pick<Message, 'parts'>): string {
  return message.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('');
}
