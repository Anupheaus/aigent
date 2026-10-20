import { openTurnStream } from '../core/open-turn-stream.js';
import type { TurnRouting } from '../core/open-turn-stream.js';
import { toProviderTarget } from '../core/run-settings.js';
import type { ResolvedAgent, RuntimeServices } from '../core/start-task-run.js';
import { parseTaskInput } from '../core/task-input.js';
import type { Usage } from '../providers/provider-types.js';
import type { PatchLog } from './apply-patch.js';
import { messageText } from './message.js';

const TITLE_PROMPT = 'Name this conversation in at most six words. Reply with the title only, no quotes or punctuation at the end.';
const MAX_TITLE_LENGTH = 60;
const EXCHANGE_TEXT_LENGTH = 1_000;
/** A title is a nicety: one that takes longer than this (queueing, retries and all) is given up. */
export const TITLE_TIMEOUT_MS = 30_000;

export interface TitleResult {
  title: string;
  usage: Usage;
}

/** The agent's models, as a background request: scheduler lease, retry, first-event timeout and fallback apply. */
export function titleRouting(params: { agent: ResolvedAgent; services: RuntimeServices }): TurnRouting {
  const { agent, services: { sleep, random, scheduler } } = params;
  const input = parseTaskInput({ task: TITLE_PROMPT });
  const [primary, ...fallbacks] = agent.targets;
  const targets: TurnRouting['targets'] = [toProviderTarget({ target: primary, agent, input }), ...fallbacks.map(target => toProviderTarget({ target, agent, input }))];
  // The replies already reported each target's setting warnings: a title call repeats none (all are marked used).
  return { targets, policy: agent.resilience, sleep, random, scheduler, priority: 'background', agentName: agent.name, usedLabels: new Set(targets.map(({ label }) => label)) };
}

/** Aborts when any of `signals` does or after `timeoutMs`; `dispose` clears the timer and listeners. */
function boundedSignal(params: { signals: AbortSignal[]; timeoutMs: number }): { signal: AbortSignal; dispose(): void } {
  const { signals, timeoutMs } = params;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  for (const signal of signals) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); for (const signal of signals) signal.removeEventListener('abort', abort); } };
}

/** One cheap call naming the session from its first exchange; undefined when the model gave nothing usable, failed or was aborted. */
export async function generateTitle(params: { routing: TurnRouting; exchange: { user: string; agent: string }; signal: AbortSignal }): Promise<TitleResult | undefined> {
  const { routing, exchange, signal } = params;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let text = '';
  try {
    const conversation = `User: ${exchange.user.slice(0, EXCHANGE_TEXT_LENGTH)}\nAgent: ${exchange.agent.slice(0, EXCHANGE_TEXT_LENGTH)}`;
    const request = { messages: [{ role: 'system' as const, text: TITLE_PROMPT }, { role: 'user' as const, text: conversation }], tools: [] };
    const stream = openTurnStream({ routing, request, signal, counters: { retries: 0, fallbacks: 0 }, emit: () => undefined });
    for await (const event of stream) {
      if (event.type === 'text-delta') text += event.text;
      if (event.type === 'usage') Object.assign(usage, event.usage);
    }
  } catch {
    // A title is a nicety: a failed, timed-out or aborted call leaves the session untitled rather than failing anything.
    return undefined;
  }
  const title = text.split('\n')[0]?.trim().slice(0, MAX_TITLE_LENGTH) ?? '';
  return title === '' ? undefined : { title, usage };
}

export interface TitleSessionParams {
  log: PatchLog;
  routing: TurnRouting;
  /** Abort the call (the chat closing, its own signal). */
  signals: AbortSignal[];
  timeoutMs?: number;
}

/** Titles an untitled session after its first exchange; the call's tokens are counted apart (`usage.title`). */
export async function titleSession(params: TitleSessionParams): Promise<void> {
  const { log, routing, signals, timeoutMs = TITLE_TIMEOUT_MS } = params;
  const { messages, title: current } = log.state();
  const user = messages.find(({ role, kind }) => role === 'user' && kind === 'statement');
  const agent = messages.find(({ role, kind, state }) => role === 'agent' && kind === 'statement' && state === 'complete');
  if (current != null || user == null || agent == null) return;
  const bounded = boundedSignal({ signals, timeoutMs });
  const result = await generateTitle({ routing, exchange: { user: messageText(user), agent: messageText(agent) }, signal: bounded.signal }).finally(bounded.dispose);
  if (result == null || log.state().title != null) return;
  const { usage } = log.state();
  const spent = usage.title ?? { inputTokens: 0, outputTokens: 0 };
  log.append({ type: 'title-updated', title: result.title });
  log.append({ type: 'usage-updated', usage: { ...usage, title: { inputTokens: spent.inputTokens + result.usage.inputTokens, outputTokens: spent.outputTokens + result.usage.outputTokens } } });
}
