import type { TaskResult } from '../core/agent-types.js';
import { stripCitationMarkers } from '../core/citations.js';
import type { RunSummary } from '../core/finish-agent-run.js';
import type { ProviderMessage } from '../providers/provider-types.js';
import type { PatchLog } from './apply-patch.js';
import type { ChatReply } from './chat-types.js';
import type { ConversationUsage } from './conversation.js';
import type { Message, MessageMeta, MessageState } from './message.js';

export interface FinishTurnParams {
  log: PatchLog;
  messageId: string;
  result: TaskResult;
  summary?: RunSummary;
  /** Every message the run committed, in order: what the model saw for this reply. */
  history: ProviderMessage[];
  agentName: string;
  instanceId: string;
  /** Set when a new message interrupted this reply. */
  interruptedBy?: string;
  now(): number;
}

function messageState(status: TaskResult['status']): MessageState {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'complete';
}

/** Message meta from the run's own figures, so a UI shows what the run record and `ai.report()` hold. */
function replyMeta(params: FinishTurnParams): MessageMeta {
  const { result: { runId, responseId, usage, status, failure, citations }, summary, history, agentName, instanceId } = params;
  const [provider, ...modelParts] = (summary?.model ?? '').split(':');
  const timing = summary?.timings;
  return {
    agentName, instanceId, runId, responseId,
    ...(summary == null ? {} : { provider, model: modelParts.join(':') }),
    tokens: { input: usage.inputTokens, output: usage.outputTokens, cached: usage.cachedTokens },
    ...(summary?.costUsd == null ? {} : { costUsd: summary.costUsd }),
    ...(timing == null ? {} : { timing: { startedAt: timing.startedAt, ...(timing.firstTokenMs == null ? {} : { firstTokenMs: timing.firstTokenMs }), totalMs: timing.durationMs, toolMs: timing.toolMs } }),
    toolCalls: usage.toolCalls, cacheHits: summary?.cacheHits ?? 0,
    ...(status === 'completed' ? { finishReason: 'stop' as const } : {}),
    ...(status === 'incomplete' ? { finishReason: 'length' as const, truncated: true } : {}),
    ...(failure == null ? {} : { error: failure }),
    ...(citations == null ? {} : { citations }),
    history,
  };
}

function addUsage(params: { usage: ConversationUsage; result: TaskResult; costUsd?: number }): ConversationUsage {
  const { usage, result: { usage: run }, costUsd = 0 } = params;
  return {
    ...usage, inputTokens: usage.inputTokens + run.inputTokens, outputTokens: usage.outputTokens + run.outputTokens, cachedTokens: usage.cachedTokens + run.cachedTokens,
    costUsd: usage.costUsd + costUsd, turns: usage.turns + run.turns, toolCalls: usage.toolCalls + run.toolCalls, replies: usage.replies + 1,
  };
}

/** Completes the agent message with its meta and adds the run to the session's usage; returns the reply. */
export function finishTurn(params: FinishTurnParams): ChatReply {
  const { log, messageId, result, summary, interruptedBy, now } = params;
  const current: Message | undefined = log.state().messages.find(({ id }) => id === messageId);
  const meta = { ...current?.meta, ...replyMeta(params) };
  // The streamed text kept the citation markers; the stored reply reads as `ChatReply.text` does.
  const [first, ...rest] = current?.parts ?? [];
  const parts = first?.type === 'text' && stripCitationMarkers(first.text) !== first.text ? { parts: [{ ...first, text: stripCitationMarkers(first.text) }, ...rest] } : {};
  log.append({ type: 'message-updated', messageId, set: { meta, ...parts, state: messageState(result.status), completedAt: now() } });
  // Only a reply that really was cut short is marked; one that finished before the interrupt landed stays complete.
  if (interruptedBy != null && result.status === 'cancelled') log.append({ type: 'message-interrupted', messageId, byMessageId: interruptedBy });
  log.append({ type: 'usage-updated', usage: addUsage({ usage: log.state().usage, result, ...(summary?.costUsd == null ? {} : { costUsd: summary.costUsd }) }) });
  const { answer, responseId, usage, status } = result;
  const reply = { text: answer, responseId, messageId, usage, status };
  return Object.defineProperty(reply, 'feedback', { value: result.feedback, enumerable: false }) as ChatReply;
}
