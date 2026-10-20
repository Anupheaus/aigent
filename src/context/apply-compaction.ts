import { replaceMessageContent } from './context-message.js';
import type { ContextMessage } from './context-message.js';

/** A stub's text and the handle its original is kept under. */
export interface StubReplacement {
  text: string;
  handle: string;
}

/** A plan with its effects resolved: handles issued, the summary written. */
export interface CompactionChanges {
  /** Message id → its stub. */
  stubs: ReadonlyMap<string, StubReplacement>;
  /** Message id → the reference that replaces an older duplicate. */
  dedupes: ReadonlyMap<string, string>;
  /** Messages folded into `summary`. */
  summarise: readonly string[];
  /** The new single summary (the previous one is merged into it and removed). Absent: any existing summary stays. */
  summary?: ContextMessage;
  /**
   * First message of the recent window: from it on, non-compactable messages keep their chronological place after the
   * summary. Absent: every message is older than the window.
   */
  recentFrom?: string;
}

export interface ApplyCompactionParams {
  state: readonly ContextMessage[];
  changes: CompactionChanges;
}

/** Only compactable messages are ever rewritten; anything else passed in by mistake is left as it is. */
function rewrite(params: { message: ContextMessage; changes: CompactionChanges }): ContextMessage {
  const { message, changes: { stubs, dedupes } } = params;
  if (!message.compactable) return message;
  const stub = stubs.get(message.id);
  const text = stub?.text ?? dedupes.get(message.id);
  if (text == null) return message;
  const replaced = replaceMessageContent({ context: message, message: { ...message.message, text } });
  return { ...replaced, kind: 'stub', ...(stub == null ? {} : { originalHandle: stub.handle }) };
}

/** Ids of the older messages that move ahead of the summary: non-compactable ones, with every message of their round. */
function hoistedIds(params: { older: readonly ContextMessage[] }): Set<string> {
  const { older } = params;
  const keptRounds = new Set(older.flatMap(({ compactable, pairId }) => (!compactable && pairId != null ? [pairId] : [])));
  return new Set(older.filter(({ compactable, kind, pairId }) => kind !== 'summary' && (!compactable || (pairId != null && keptRounds.has(pairId)))).map(({ id }) => id));
}

/**
 * The state after a compaction: stubs and references in place, summarised messages gone, then the hoist. Older
 * non-compactable messages (those accrued since the last compaction included) move, in stable chronological order,
 * ahead of the one summary; a tool round moves whole, so its compactable results (stubbed by the plan) are frozen
 * as non-compactable to keep the pair together. The rest (compactable messages, and every message of the recent window)
 * follow in their order. Ids are kept and seqs reassigned. Non-compactable content is never altered and compactable
 * messages never change their relative order.
 */
export function applyCompaction(params: ApplyCompactionParams): ContextMessage[] {
  const { state, changes } = params;
  const { summarise, summary, recentFrom } = changes;
  const removed = new Set(summarise);
  const kept = state
    .filter(({ id, kind }) => !removed.has(id) && !(summary != null && kind === 'summary'))
    .map(message => rewrite({ message, changes }));
  const summaries = summary == null ? kept.filter(({ kind }) => kind === 'summary') : [summary];
  const recentIndex = recentFrom == null ? -1 : kept.findIndex(({ id }) => id === recentFrom);
  const older = recentIndex === -1 ? kept : kept.slice(0, recentIndex);
  const hoisted = hoistedIds({ older });
  const front = kept.filter(({ id }) => hoisted.has(id)).map(message => (message.compactable ? { ...message, compactable: false } : message));
  const rest = kept.filter(({ id, kind }) => !hoisted.has(id) && kind !== 'summary');
  return [...front, ...summaries, ...rest].map((message, seq) => ({ ...message, seq }));
}
