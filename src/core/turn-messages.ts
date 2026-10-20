import { envelopeText } from '../tools/envelope-text.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { NewContextMessage } from './run-context.js';
import type { TurnStreamResult } from './run-turn.js';

export interface TurnMessagesParams {
  /** The round's response as stored: its guarded text, calls and thinking. */
  turn: Pick<TurnStreamResult, 'visible' | 'calls' | 'thinkingBlocks'>;
  executed: ExecutedToolCall[];
  /** Resolves each result's tool; one with `compactable: false` keeps its result and the round's call verbatim. */
  registry: ToolRegistry;
}

/**
 * The assistant message (with its tool calls and thinking blocks) followed by one tool message per call, in call
 * order, all sharing the first call's id as `pairId` so compaction keeps them together.
 */
export function turnMessages(params: TurnMessagesParams): NewContextMessage[] {
  const { turn: { visible, calls, thinkingBlocks }, executed, registry } = params;
  const pairId = calls[0]?.id;
  const isKept = ({ envelope: { tool } }: ExecutedToolCall): boolean => registry.get(tool)?.compactable === false;
  const keptFlags = { flags: { compactable: false } };
  // A kept result pins its call (the pair must stay together); its compactable siblings can still be stubbed in place.
  const isCallKept = executed.some(isKept);
  const paired = pairId == null ? {} : { pairId };
  const assistant: NewContextMessage = {
    kind: 'assistant',
    message: { role: 'assistant', text: visible, ...(calls.length > 0 ? { toolCalls: calls } : {}), ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}) },
    ...paired, ...(isCallKept ? keptFlags : {}),
  };
  const toolResults = executed.map((call): NewContextMessage => ({
    kind: 'tool',
    message: { role: 'tool', toolCallId: call.envelope.id, text: envelopeText(call.envelope) },
    ...paired, ...(isKept(call) ? keptFlags : {}),
  }));
  return [assistant, ...toolResults];
}
