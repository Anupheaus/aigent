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

/**
 * The state after a compaction: stubs and references in place, summarised messages gone, then the hoist: every
 * non-compactable message (those accrued since the last compaction included) in stable chronological order, then the
 * one summary, then the remaining compactable messages in their order. Ids are kept and seqs reassigned. Non-compactable
 * content is never altered and compactable messages never change their relative order.
 */
export function applyCompaction(params: ApplyCompactionParams): ContextMessage[] {
  const { state, changes } = params;
  const { summarise, summary } = changes;
  const removed = new Set(summarise);
  const kept = state
    .filter(({ id, kind }) => !removed.has(id) && !(summary != null && kind === 'summary'))
    .map(message => rewrite({ message, changes }));
  const summaries = summary == null ? kept.filter(({ kind }) => kind === 'summary') : [summary];
  const nonCompactable = kept.filter(({ compactable, kind }) => !compactable && kind !== 'summary');
  const compactable = kept.filter(({ compactable: isCompactable }) => isCompactable);
  return [...nonCompactable, ...summaries, ...compactable].map((message, seq) => ({ ...message, seq }));
}
