import type { ModelTarget } from '../core/start-task-run.js';
import type { Usage } from '../providers/provider-types.js';
import type { PatchLog } from './apply-patch.js';
import { messageText } from './message.js';

const TITLE_PROMPT = 'Name this conversation in at most six words. Reply with the title only, no quotes or punctuation at the end.';
const MAX_TITLE_LENGTH = 60;
const EXCHANGE_TEXT_LENGTH = 1_000;

export interface TitleResult {
  title: string;
  usage: Usage;
}

/** One cheap call naming the session from its first exchange; undefined when the model gave nothing usable or failed. */
export async function generateTitle(params: { target: ModelTarget; exchange: { user: string; agent: string } }): Promise<TitleResult | undefined> {
  const { target: { provider, model }, exchange } = params;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let text = '';
  try {
    const conversation = `User: ${exchange.user.slice(0, EXCHANGE_TEXT_LENGTH)}\nAgent: ${exchange.agent.slice(0, EXCHANGE_TEXT_LENGTH)}`;
    const request = { model, messages: [{ role: 'system' as const, text: TITLE_PROMPT }, { role: 'user' as const, text: conversation }], tools: [] };
    for await (const event of provider.stream(request, new AbortController().signal)) {
      if (event.type === 'text-delta') text += event.text;
      if (event.type === 'usage') Object.assign(usage, event.usage);
    }
  } catch {
    // A title is a nicety: a failed call leaves the session untitled rather than failing the reply.
    return undefined;
  }
  const title = text.split('\n')[0]?.trim().slice(0, MAX_TITLE_LENGTH) ?? '';
  return title === '' ? undefined : { title, usage };
}

/** Titles an untitled session after its first exchange; the call's tokens are counted apart (`usage.title`). */
export async function titleSession(params: { log: PatchLog; target: ModelTarget }): Promise<void> {
  const { log, target } = params;
  const { messages, title: current } = log.state();
  const user = messages.find(({ role, kind }) => role === 'user' && kind === 'statement');
  const agent = messages.find(({ role, kind, state }) => role === 'agent' && kind === 'statement' && state === 'complete');
  if (current != null || user == null || agent == null) return;
  const result = await generateTitle({ target, exchange: { user: messageText(user), agent: messageText(agent) } });
  if (result == null || log.state().title != null) return;
  const { usage } = log.state();
  const spent = usage.title ?? { inputTokens: 0, outputTokens: 0 };
  log.append({ type: 'title-updated', title: result.title });
  log.append({ type: 'usage-updated', usage: { ...usage, title: { inputTokens: spent.inputTokens + result.usage.inputTokens, outputTokens: spent.outputTokens + result.usage.outputTokens } } });
}
