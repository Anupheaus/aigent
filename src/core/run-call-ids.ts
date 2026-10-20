import type { ToolCall } from '../providers/provider-types.js';
import type { RunContext } from './run-context.js';

/** The id given to a call the provider sent without one. */
const MISSING_ID = 'call';

/**
 * Keeps every tool call id unique within a run. Providers that omit ids (OpenAI-compatible servers get `call_<n>`,
 * restarting each response) or repeat them would otherwise share one ledger entry, idempotency key and effect-log entry
 * between different calls; a repeated id is renamed for the rest of the run (the model only ever sees the new id).
 */
export interface RunCallIds {
  unique(params: { call: ToolCall; turn: number }): ToolCall;
}

/** The ids the run's messages already use (a resumed run's or a chat's history), and any others to avoid (the ledger's). */
export function createRunCallIds(params: { context: RunContext; reserved?: Iterable<string> }): RunCallIds {
  const { context, reserved = [] } = params;
  const used = new Set<string>(reserved);
  for (const { message: { toolCallId, toolCalls = [] } } of context.state) {
    if (toolCallId != null) used.add(toolCallId);
    for (const { id } of toolCalls) used.add(id);
  }
  return {
    unique: ({ call, turn }) => {
      if (call.id !== '' && !used.has(call.id)) {
        used.add(call.id);
        return call;
      }
      const base = `${call.id === '' ? MISSING_ID : call.id}_t${turn}`;
      let id = base;
      for (let attempt = 1; used.has(id); attempt += 1) id = `${base}_${attempt}`;
      used.add(id);
      return { ...call, id };
    },
  };
}
