import { createAigentError } from '../core/aigent-error.js';
import type { MemoryScope } from './memory-types.js';

export interface MemoryScopeKeyParams {
  scope: MemoryScope;
  runId: string;
  /** The chat session, for a chat turn. */
  sessionId?: string;
  /** From `interfaceKeyOf`. */
  interfaceKey?: string;
}

/**
 * Which memories a run reads and writes: `agent` (every run of every agent with the name), `session:<id>` (one chat
 * session; a task is its own session) or `interface:<key>` (the consumer's key). Throws `invalid_input` for interface
 * scope without a key, so memories never silently land in a shared bucket.
 */
export function memoryScopeKey(params: MemoryScopeKeyParams): string {
  const { scope, runId, sessionId, interfaceKey } = params;
  if (scope === 'agent') return 'agent';
  if (scope === 'session') return `session:${sessionId ?? runId}`;
  if (interfaceKey == null) {
    throw createAigentError({ code: 'invalid_input', message: "Memory scope 'interface' needs a key: pass memoryScopeKey (or scope.interface) with the task or chat", details: { runId } });
  }
  return `interface:${interfaceKey}`;
}

/** The fields of a task or chat that can name an interface. */
export interface InterfaceKeySource {
  memoryScopeKey?: string;
  scope?: Record<string, string>;
}

/** The consumer's interface key: `memoryScopeKey`, else `scope.interface`. */
export function interfaceKeyOf(source: InterfaceKeySource): string | undefined {
  return source.memoryScopeKey ?? source.scope?.interface;
}
