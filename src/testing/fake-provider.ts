import { createAigentError } from '../core/aigent-error.js';
import type { Provider, ProviderCapabilities, ProviderEvent, ProviderRequest, ToolCall, Usage } from '../providers/provider-types.js';

/** One scripted model response. */
export interface FakeTurn {
  events: ProviderEvent[];
  /** Pause before each event, to test overlap and abort timing. */
  delayMs?: number;
}

export interface TurnOptions {
  delayMs?: number;
  usage?: Usage;
}

export interface TextTurnOptions extends TurnOptions {
  /** Split the text into chunks of this many characters (default: one chunk). */
  chunkSize?: number;
}

export interface FakeProviderOptions {
  id?: string;
  turns: FakeTurn[];
}

export interface FakeProvider extends Provider {
  /** Deep copies of every request received, in order. */
  requests: ProviderRequest[];
}

const DEFAULT_USAGE: Usage = { inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
const FAKE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: true,
  promptCaching: false,
  vision: false,
  maxContextTokens: 128_000,
};

function chunkText(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0 || text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += chunkSize) chunks.push(text.slice(start, start + chunkSize));
  return chunks;
}

export function textTurn(text: string, options: TextTurnOptions = {}): FakeTurn {
  const { chunkSize = text.length, delayMs, usage = DEFAULT_USAGE } = options;
  const events: ProviderEvent[] = chunkText(text, chunkSize).map(chunk => ({ type: 'text-delta', text: chunk }));
  events.push({ type: 'usage', usage }, { type: 'done', finishReason: 'stop' });
  return { events, delayMs };
}

export function toolTurn(calls: ToolCall[], options: TurnOptions = {}): FakeTurn {
  const { delayMs, usage = DEFAULT_USAGE } = options;
  const events: ProviderEvent[] = calls.map(call => ({ type: 'tool-call', call }));
  events.push({ type: 'usage', usage }, { type: 'done', finishReason: 'tool_calls' });
  return { events, delayMs };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

export function createFakeProvider(options: FakeProviderOptions): FakeProvider {
  const { id = 'fake', turns } = options;
  const requests: ProviderRequest[] = [];
  let turnIndex = 0;

  async function* stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    const turn = turns[turnIndex];
    turnIndex += 1;
    if (turn == null) {
      throw createAigentError({ code: 'provider_failed', message: `FakeProvider '${id}' has no scripted turn for request ${turnIndex}; scripted ${turns.length}` });
    }
    for (const event of turn.events) {
      if (turn.delayMs != null && turn.delayMs > 0) await sleep(turn.delayMs);
      if (signal.aborted) throw createAigentError({ code: 'aborted', message: `FakeProvider '${id}' stream aborted` });
      yield event;
    }
  }

  return { id, capabilities: FAKE_CAPABILITIES, requests, stream };
}
