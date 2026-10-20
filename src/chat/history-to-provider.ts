import type { NewContextMessage } from '../core/run-context.js';
import type { ContextMessageKind } from '../context/message-flags.js';
import type { ProviderMessage } from '../providers/provider-types.js';
import { envelopeText } from '../tools/envelope-text.js';
import type { Message } from './message.js';
import { messageText } from './message.js';

/** The result given to a tool call that never got one (its turn was cut short), so the history stays provider-valid. */
export function abortedResultMessage(params: { callId: string; tool: string }): ProviderMessage {
  const { callId, tool } = params;
  return {
    role: 'tool', toolCallId: callId,
    text: envelopeText({ id: callId, tool, ok: false, error: { category: 'aborted', code: 'turn_interrupted', retryable: true, message: `Tool '${tool}' did not return: its turn was interrupted` } }),
  };
}

/** What the model sees for one message: its recorded history, or its text for a reply cut short before it had one. */
function modelMessages(message: Message): ProviderMessage[] {
  const { meta: { history }, role, kind } = message;
  if (history != null) return history;
  if (role !== 'agent' || kind !== 'statement') return [];
  const text = messageText(message);
  return text === '' ? [] : [{ role: 'assistant', text }];
}

function contextKind(params: { message: Message; provider: ProviderMessage }): ContextMessageKind {
  const { message: { kind }, provider: { role } } = params;
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'tool';
  if (kind === 'answer' || kind === 'summary') return kind;
  return 'user';
}

/**
 * Makes the sequence provider-valid: every assistant tool call is followed by its result (a synthetic `aborted` one
 * when it never got one), results without their call are dropped, and empty assistant messages are left out.
 */
export function repairToolPairs(messages: ProviderMessage[]): ProviderMessage[] {
  const repaired: ProviderMessage[] = [];
  let open = new Map<string, string>();
  const closeOpen = (): void => {
    for (const [callId, tool] of open) repaired.push(abortedResultMessage({ callId, tool }));
    open = new Map();
  };
  for (const message of messages) {
    const { role, toolCalls = [], toolCallId, text } = message;
    if (role === 'tool') {
      if (toolCallId == null || !open.has(toolCallId)) continue;
      open.delete(toolCallId);
      repaired.push(message);
      continue;
    }
    closeOpen();
    if (role === 'assistant' && toolCalls.length === 0 && (text ?? '') === '') continue;
    repaired.push(message);
    for (const { id, name } of toolCalls) open.set(id, name);
  }
  closeOpen();
  return repaired;
}

/** Tool rounds are linked by the first call's id (as the run does), so compaction keeps each round together. */
function pairIds(messages: ProviderMessage[]): (string | undefined)[] {
  let current: string | undefined;
  return messages.map(({ role, toolCalls }) => {
    if (role === 'assistant') current = toolCalls?.[0]?.id;
    else if (role !== 'tool') current = undefined;
    return role === 'assistant' || role === 'tool' ? current : undefined;
  });
}

/** The model-visible history of a lineage (main line or a thread context), repaired and flagged for compaction. */
export function historyToProvider(lineage: readonly Message[]): NewContextMessage[] {
  const entries = lineage.flatMap(message => modelMessages(message).map(provider => ({ message, provider })));
  const repaired = repairToolPairs(entries.map(({ provider }) => provider));
  const owners = new Map(entries.map(({ message, provider }) => [provider, message]));
  const pairs = pairIds(repaired);
  return repaired.map((provider, index): NewContextMessage => {
    const owner = owners.get(provider);
    const pairId = pairs[index];
    const flags = owner == null ? undefined : { compactable: owner.compactable && !owner.pinned, pinned: owner.pinned };
    return { message: provider, kind: owner == null ? 'tool' : contextKind({ message: owner, provider }), ...(flags == null ? {} : { flags }), ...(pairId == null ? {} : { pairId }) };
  });
}
