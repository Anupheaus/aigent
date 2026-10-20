import type { ProviderMessage } from '../providers/provider-types.js';
import type { Message, MessageAttachment, MessageDelivery, MessageMeta, Part } from './message.js';

export interface UserMessageParams {
  id: string;
  text: string;
  branchId: string;
  createdAt: number;
  /** What the model is sent for it (attachments inlined or summarised). */
  modelText: string;
  delivery?: MessageDelivery;
  replyTo?: string;
  threadId?: string;
  compactable?: boolean;
  attachments?: MessageAttachment[];
  extraParts?: Part[];
}

/** A user's message; `meta.history` holds what the model sees for it. */
export function userMessage(params: UserMessageParams): Message {
  const { id, text, branchId, createdAt, modelText, delivery, replyTo, threadId, compactable = true, attachments, extraParts = [] } = params;
  const meta: MessageMeta = { history: [{ role: 'user', text: modelText }], ...(attachments == null || attachments.length === 0 ? {} : { attachments }) };
  return {
    id, seq: 0, role: 'user', kind: 'statement', parts: [{ type: 'text', text }, ...extraParts], branchId, state: 'complete', createdAt, completedAt: createdAt, pinned: false, compactable, meta,
    ...(delivery == null ? {} : { delivery }), ...(replyTo == null ? {} : { replyTo }), ...(threadId == null ? {} : { threadId }),
  };
}

export interface AgentMessageParams {
  id: string;
  branchId: string;
  createdAt: number;
  agentName: string;
  instanceId: string;
  replyTo?: string;
  threadId?: string;
}

/** The agent's reply as it starts streaming: one empty text part that streamed deltas extend. */
export function agentMessage(params: AgentMessageParams): Message {
  const { id, branchId, createdAt, agentName, instanceId, replyTo, threadId } = params;
  return {
    id, seq: 0, role: 'agent', kind: 'statement', parts: [{ type: 'text', text: '' }], branchId, state: 'streaming', createdAt, pinned: false, compactable: true, meta: { agentName, instanceId },
    ...(replyTo == null ? {} : { replyTo }), ...(threadId == null ? {} : { threadId }),
  };
}

export interface ToolActivityMessageParams {
  id: string;
  branchId: string;
  createdAt: number;
  runId: string;
  replyTo: string;
  threadId?: string;
}

/** A collapsible row group for one model request's tool calls; UI only (the model sees them in the reply's history). */
export function toolActivityMessage(params: ToolActivityMessageParams): Message {
  const { id, branchId, createdAt, runId, replyTo, threadId } = params;
  return {
    id, seq: 0, role: 'tool', kind: 'tool_activity', parts: [], branchId, state: 'streaming', createdAt, pinned: false, compactable: true, meta: { runId }, replyTo,
    ...(threadId == null ? {} : { threadId }),
  };
}

export interface SummaryMessageParams {
  id: string;
  branchId: string;
  createdAt: number;
  text: string;
  replyTo?: string;
}

/** A summary on the main line (a promoted thread); the model sees it as a user note. */
export function summaryMessage(params: SummaryMessageParams): Message {
  const { id, branchId, createdAt, text, replyTo } = params;
  const history: ProviderMessage[] = [{ role: 'user', text }];
  return {
    id, seq: 0, role: 'system', kind: 'summary', parts: [{ type: 'text', text }], branchId, state: 'complete', createdAt, completedAt: createdAt, pinned: false, compactable: false,
    meta: { history }, ...(replyTo == null ? {} : { replyTo }),
  };
}
