import type { Provider, ProviderEvent, ProviderRequest } from '../providers/provider-types.js';
import { PROVIDER_SETTING_KEYS } from '../providers/provider-settings.js';
import type { Store } from '../store/store-types.js';
import { MEMORY_COLLECTION } from './memory-types.js';
import type { MemoryEntry } from './memory-types.js';

const USAGE = { inputTokens: 10, outputTokens: 5, cachedTokens: 0 };

/** A provider that answers each request from the request itself, so many concurrent runs can share it. */
export interface RespondingProvider extends Provider {
  requests: ProviderRequest[];
}

export function createRespondingProvider(respond: (request: ProviderRequest) => ProviderEvent[]): RespondingProvider {
  const requests: ProviderRequest[] = [];
  return {
    id: 'fake',
    requests,
    capabilities: { streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 128_000, supportedSettings: [...PROVIDER_SETTING_KEYS] },
    async* stream(request) {
      requests.push(structuredClone(request));
      // Yield once, so concurrent runs interleave.
      await new Promise(resolve => setImmediate(resolve));
      yield* respond(request);
    },
  };
}

/** Tool-call events of one response. */
export function callEvents(calls: { id: string; name: string; args: unknown }[]): ProviderEvent[] {
  return [...calls.map((call): ProviderEvent => ({ type: 'tool-call', call })), { type: 'usage', usage: USAGE }, { type: 'done', finishReason: 'tool_calls' }];
}

/** A plain answer. */
export function answerEvents(text: string): ProviderEvent[] {
  return [{ type: 'text-delta', text }, { type: 'usage', usage: USAGE }, { type: 'done', finishReason: 'stop' }];
}

/** Whether the request already carries a tool result (the run's second request). */
export function hasToolResult(request: ProviderRequest): boolean {
  return request.messages.some(({ role }) => role === 'tool');
}

/** The text of every message of the request, joined. */
export function requestText(request: ProviderRequest): string {
  return request.messages.map(({ text }) => text ?? '').join('\n');
}

/** Every stored memory entry. */
export async function storedMemories(store: Store): Promise<MemoryEntry[]> {
  return (await store.list<MemoryEntry>(MEMORY_COLLECTION)).map(({ value }) => value);
}
