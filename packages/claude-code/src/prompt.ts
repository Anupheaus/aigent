import type { ProviderMessage } from '@anupheaus/aigent';

/** What one Claude Code run is given: the system prompt and a single prompt carrying the conversation. */
export interface ClaudeCodePrompt {
  system: string;
  prompt: string;
}

const SECTION_SEPARATOR = '\n\n';
const TRANSCRIPT_INTRO = 'The conversation so far follows. Continue it: reply to the last user message.';

function sectionOf(message: ProviderMessage): string {
  const { role, text = '', toolCalls = [], toolCallId } = message;
  if (role === 'tool') return `### Tool result (${String(toolCallId)})\n${text}`;
  if (role === 'assistant') {
    const calls = toolCalls.map(({ id, name, args }) => `### Tool call ${name} (${id})\n${JSON.stringify(args)}`);
    return [...(text === '' ? [] : [`### Assistant\n${text}`]), ...calls].join(SECTION_SEPARATOR);
  }
  return `### User\n${text}`;
}

/**
 * The SDK takes one prompt per run, so the whole history is sent each turn: system messages and the volatile
 * `# Current state` block (plan, todo, progress) go to the system prompt; a single user message is the prompt itself;
 * a longer history becomes a transcript.
 */
export function buildPrompt(messages: ProviderMessage[]): ClaudeCodePrompt {
  const system = messages.filter(({ role, volatile }) => role === 'system' || volatile === true).map(({ text = '' }) => text).filter(text => text !== '');
  const conversation = messages.filter(({ role, volatile }) => role !== 'system' && volatile !== true);
  const [only] = conversation;
  const prompt = conversation.length === 1 && only?.role === 'user'
    ? only.text ?? ''
    : [TRANSCRIPT_INTRO, ...conversation.map(sectionOf).filter(section => section !== '')].join(SECTION_SEPARATOR);
  return { system: system.join(SECTION_SEPARATOR), prompt };
}
