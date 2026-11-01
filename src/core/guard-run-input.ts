import type { NewContextMessage } from './run-context.js';
import type { RunGuardrails } from './run-guardrails.js';
import type { ConversationRun } from './start-agent-run.js';
import type { TaskInput } from './task-input.js';

export interface GuardedInput {
  input: TaskInput;
  conversation?: ConversationRun;
  /** Set when an input guardrail blocked: the run fails with it and never calls the provider. */
  blocked?: string;
  /**
   * The task text or chat message as the input stage left it (rewritten when a guardrail rewrote it): what anything
   * beyond the model, such as a memory embedder, may be sent.
   */
  checkedText?: string;
}

/** The message a chat turn answers: the last user message of its history. */
function lastUserIndex(history: NewContextMessage[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) if (history[index]?.message.role === 'user') return index;
  return -1;
}

/**
 * The `input` stage: the task text, or the chat message being answered. A rewrite replaces it in what the model is
 * sent (a chat keeps the user's own words in the conversation); a block stops the run before it starts.
 */
export async function guardRunInput(params: { guardrails: RunGuardrails; input: TaskInput; conversation?: ConversationRun }): Promise<GuardedInput> {
  const { guardrails, input, conversation } = params;
  const index = conversation == null ? -1 : lastUserIndex(conversation.history);
  const target = conversation?.history[index];
  const text = conversation == null ? input.task : target?.message.text ?? input.task;
  const checked = await guardrails.checkInput(text);
  if ('blocked' in checked) {
    const { guardrail, reason } = checked.blocked;
    return { input, ...(conversation == null ? {} : { conversation }), blocked: `Guardrail '${guardrail}' blocked the input: ${reason}` };
  }
  const checkedText = checked.text;
  if (checkedText === text) return { input, ...(conversation == null ? {} : { conversation }), checkedText };
  if (conversation == null || target == null) return { input: { ...input, task: checkedText }, checkedText };
  const history = conversation.history.map((entry, position) => (position === index ? { ...entry, message: { ...entry.message, text: checkedText } } : entry));
  return { input, conversation: { ...conversation, history }, checkedText };
}
