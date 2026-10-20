import { createContextMessage } from './context-message.js';
import type { ContextMessage } from './context-message.js';

/** Builds compaction test histories: a head, tool rounds and plain messages, with ids `r:m<n>` in stored order. */
export interface HistoryBuilder {
  head(): HistoryBuilder;
  /** One tool round: an assistant call and its result of `resultChars` characters. */
  round(params: { callId: string; resultChars?: number; text?: string; isCompactable?: boolean }): HistoryBuilder;
  answer(text: string): HistoryBuilder;
  build(): ContextMessage[];
}

export function historyBuilder(): HistoryBuilder {
  const state: ContextMessage[] = [];
  const add = (entry: Omit<Parameters<typeof createContextMessage>[0], 'runId' | 'seq' | 'createdAt'>): void => {
    state.push(createContextMessage({ runId: 'r', seq: state.length, createdAt: state.length, ...entry }));
  };
  const builder: HistoryBuilder = {
    head: () => {
      add({ kind: 'system', message: { role: 'system', text: 'rules' } });
      add({ kind: 'brief', message: { role: 'user', text: '# Task\nDo it' } });
      return builder;
    },
    round: ({ callId, resultChars = 400, text, isCompactable = true }) => {
      const flags = isCompactable ? {} : { flags: { compactable: false } };
      add({ kind: 'assistant', pairId: callId, ...flags, message: { role: 'assistant', text: '', toolCalls: [{ id: callId, name: 'read', args: { path: callId } }] } });
      add({ kind: 'tool', pairId: callId, ...flags, message: { role: 'tool', toolCallId: callId, text: text ?? `${callId}:`.padEnd(resultChars, 'x') } });
      return builder;
    },
    answer: text => {
      add({ kind: 'answer', message: { role: 'user', text } });
      return builder;
    },
    build: () => state,
  };
  return builder;
}

/** Total estimated tokens of the stored messages. */
export function stateTokens(state: readonly ContextMessage[]): number {
  return state.reduce((total, { tokens }) => total + tokens, 0);
}
