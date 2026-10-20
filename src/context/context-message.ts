import type { ProviderMessage } from '../providers/provider-types.js';
import { estimateMessageTokens } from './estimate-prompt-tokens.js';
import { defaultFlags } from './message-flags.js';
import type { ContextMessageKind, MessageFlags } from './message-flags.js';

/** One stored message of a run, with what compaction needs to know about it. */
export interface ContextMessage {
  /** Stable for the message's whole life, across compactions. */
  id: string;
  /** Position in stored order; reassigned at each compaction. */
  seq: number;
  /** Exactly what the provider is sent. */
  message: ProviderMessage;
  kind: ContextMessageKind;
  compactable: boolean;
  pinned: boolean;
  /** Estimated tokens of `message`. */
  tokens: number;
  /** Epoch ms when the message was stored. */
  createdAt: number;
  /** Handle (`result_original`) of the verbatim text a stub or compressed result replaced. */
  originalHandle?: string;
  /**
   * Links an assistant tool-call message to its tool results: the id of the assistant message's first tool call, on
   * the assistant message and on each of its results. Compaction treats such a group as one unit.
   */
  pairId?: string;
}

export interface CreateContextMessageParams {
  /** The run's id; message ids are `<runId>:m<seq>`, so they need no generator of their own. */
  runId: string;
  seq: number;
  message: ProviderMessage;
  kind: ContextMessageKind;
  createdAt: number;
  /** Overrides of `defaultFlags(kind)`, e.g. a tool result its tool marked non-compactable. */
  flags?: Partial<MessageFlags>;
  pairId?: string;
}

/** A context message with the kind's default flags (or the given overrides) and its token estimate. */
export function createContextMessage(params: CreateContextMessageParams): ContextMessage {
  const { runId, seq, message, kind, createdAt, flags, pairId } = params;
  const merged = { ...defaultFlags(kind), ...flags };
  // A pinned message is never compactable, whatever else was asked.
  const compactable = merged.pinned ? false : merged.compactable;
  return {
    id: `${runId}:m${seq}`, seq, message, kind, compactable, pinned: merged.pinned, tokens: estimateMessageTokens(message), createdAt,
    ...(pairId == null ? {} : { pairId }),
  };
}

/** The message with new provider content (a stub, a compressed result), its estimate updated. */
export function replaceMessageContent(params: { context: ContextMessage; message: ProviderMessage }): ContextMessage {
  const { context, message } = params;
  return { ...context, message, tokens: estimateMessageTokens(message) };
}

/** What the provider is sent for the stored messages, in order. */
export function toProviderMessages(state: readonly ContextMessage[]): ProviderMessage[] {
  return state.map(({ message }) => message);
}
