import { createCompressionCache } from '../compression/compression-cache.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { ChatRuntime } from './chat-turn.js';

/**
 * The runtime a `persistence: 'memory'` chat runs on: nothing of the session reaches the store. Its turns are traced
 * but their records are not written, they are not checkpointed, tool results are not cached, their effects are not
 * logged for undo, and compressed tool results stay in a private in-memory cache.
 */
export function memoryOnlyRuntime(runtime: ChatRuntime): ChatRuntime {
  const { services } = runtime;
  const { resume: _resume, cache: _cache, effects: _effects, telemetry: { writer: _writer, ...telemetry }, ...rest } = services;
  return { ...runtime, services: { ...rest, telemetry, compressionCache: createCompressionCache({ store: createInMemoryStore(), writeQueue: services.writeQueue }) } };
}
