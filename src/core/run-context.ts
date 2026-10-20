import { createContextMessage } from '../context/context-message.js';
import type { ContextMessage } from '../context/context-message.js';
import type { ContextMessageKind, MessageFlags } from '../context/message-flags.js';
import type { ProviderMessage } from '../providers/provider-types.js';
import type { StoredContext } from '../resume/checkpoint-types.js';

/** One run's stored messages and what it has learnt about their size. Mutated in place by the loop, like `RunTotals`. */
export interface RunContext {
  runId: string;
  /** Stored messages in stored order; the only input to each request besides the tools and the volatile block. */
  state: ContextMessage[];
  /** Calibration of the token estimate against provider-reported input tokens (1 until a response reports usage). */
  ratio: number;
  /** Largest prompt of the run in tokens: reported by the provider when it did, estimated otherwise. */
  peakTokens: number;
  /** Estimated tokens of the last request's volatile block, for estimates made between requests. */
  volatileTokens: number;
  /** Messages created so far; ids are `<runId>:m<n>` for the n-th, so an id is never reused after a renumber. */
  created: number;
}

/** A message to store, before it gets an id, seq and token estimate. */
export interface NewContextMessage {
  message: ProviderMessage;
  kind: ContextMessageKind;
  flags?: Partial<MessageFlags>;
  pairId?: string;
}

export interface CreateRunContextParams {
  runId: string;
  createdAt: number;
  initial: NewContextMessage[];
}

export interface AppendContextParams {
  context: RunContext;
  messages: NewContextMessage[];
  createdAt: number;
}

function toContextMessage(params: { runId: string; seq: number; entry: NewContextMessage; createdAt: number }): ContextMessage {
  const { runId, seq, entry: { message, kind, flags, pairId }, createdAt } = params;
  return createContextMessage({ runId, seq, message, kind, createdAt, ...(flags == null ? {} : { flags }), ...(pairId == null ? {} : { pairId }) });
}

export function createRunContext(params: CreateRunContextParams): RunContext {
  const { runId, createdAt, initial } = params;
  return { runId, state: initial.map((entry, seq) => toContextMessage({ runId, seq, entry, createdAt })), ratio: 1, peakTokens: 0, volatileTokens: 0, created: initial.length };
}

/** A run's context as a checkpoint stored it; new messages continue the stored numbering. */
export function restoreRunContext(params: { runId: string; stored: StoredContext }): RunContext {
  const { runId, stored: { messages, ratio, peakTokens, volatileTokens, created } } = params;
  return { runId, state: messages.map((message, seq) => ({ ...message, seq })), ratio, peakTokens, volatileTokens, created };
}

/** A new message with the run's next id, not yet stored; its seq is set where it is placed. */
export function issueContextMessage(params: { context: RunContext; entry: NewContextMessage; createdAt: number }): ContextMessage {
  const { context, entry, createdAt } = params;
  const issued = toContextMessage({ runId: context.runId, seq: context.created, entry, createdAt });
  context.created += 1;
  return issued;
}

/** Appends messages at the end of stored order (the only way history grows between compactions). */
export function appendContextMessages(params: AppendContextParams): void {
  const { context, messages, createdAt } = params;
  const { state } = context;
  for (const entry of messages) state.push({ ...issueContextMessage({ context, entry, createdAt }), seq: state.length });
}

/** Reassigns `seq` to stored order after an insertion, removal or hoist; ids are kept. */
export function renumber(state: ContextMessage[]): void {
  state.forEach((message, position) => { message.seq = position; });
}
