import type { ContextMessage } from './context-message.js';

/**
 * A unit of compaction: one tool round (the assistant message with its calls and every result, linked by `pairId`)
 * or one other message. Groups are stubbed and summarised whole, so a call is never separated from its result.
 */
export interface CompactionGroup {
  messages: ContextMessage[];
  /** True when every message in it is compactable. */
  isCompactable: boolean;
  /** An assistant call in it has no result yet; such a group is never touched. */
  isPending: boolean;
}

function isPending(messages: readonly ContextMessage[]): boolean {
  const answered = new Set(messages.map(({ message: { toolCallId } }) => toolCallId).filter(id => id != null));
  return messages.some(({ message: { toolCalls = [] } }) => toolCalls.some(({ id }) => !answered.has(id)));
}

function toGroup(messages: ContextMessage[]): CompactionGroup {
  return { messages, isCompactable: messages.every(({ compactable }) => compactable), isPending: isPending(messages) };
}

/** The history after the summary (or the head) as groups in stored order; the system, brief and summary are not in any. */
export function compactionGroups(state: readonly ContextMessage[]): CompactionGroup[] {
  const groups: ContextMessage[][] = [];
  for (const message of state) {
    if (message.kind === 'system' || message.kind === 'brief' || message.kind === 'summary') continue;
    const current = groups.at(-1);
    const isSameRound = message.pairId != null && current?.[0]?.pairId === message.pairId && message.message.role === 'tool';
    if (isSameRound) current.push(message);
    else groups.push([message]);
  }
  return groups.map(toGroup);
}
