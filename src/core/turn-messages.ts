import { envelopeText } from '../tools/envelope-text.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { NewContextMessage } from './run-context.js';
import type { TurnStreamResult } from './run-turn.js';

export interface TurnMessagesParams {
  turn: TurnStreamResult;
  executed: ExecutedToolCall[];
  /** Resolves each result's tool; one with `compactable: false` keeps the whole round out of compaction. */
  registry: ToolRegistry;
}

/**
 * The assistant message (with its tool calls and thinking blocks) followed by one tool message per call, in call
 * order, all sharing the first call's id as `pairId` so compaction keeps them together.
 */
export function turnMessages(params: TurnMessagesParams): NewContextMessage[] {
  const { turn: { visible, calls, thinkingBlocks }, executed, registry } = params;
  const pairId = calls[0]?.id;
  // One non-compactable result keeps its whole round: the hoist must move the call and every result together.
  const isKept = executed.some(({ envelope: { tool } }) => registry.get(tool)?.compactable === false);
  const paired = { ...(pairId == null ? {} : { pairId }), ...(isKept ? { flags: { compactable: false } } : {}) };
  const assistant: NewContextMessage = {
    kind: 'assistant',
    message: { role: 'assistant', text: visible, ...(calls.length > 0 ? { toolCalls: calls } : {}), ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}) },
    ...paired,
  };
  const toolResults = executed.map(({ envelope }): NewContextMessage => ({
    kind: 'tool',
    message: { role: 'tool', toolCallId: envelope.id, text: envelopeText(envelope) },
    ...paired,
  }));
  return [assistant, ...toolResults];
}
