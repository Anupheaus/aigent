/** Every kind of stored context message. */
export const CONTEXT_MESSAGE_KINDS = ['system', 'brief', 'user', 'assistant', 'tool', 'question', 'answer', 'summary', 'pinned', 'directive', 'stub'] as const;

export type ContextMessageKind = typeof CONTEXT_MESSAGE_KINDS[number];

/** How compaction may treat a message. */
export interface MessageFlags {
  /** False: never stubbed, deduplicated, summarised or altered; hoisted ahead of the summary at each compaction. */
  compactable: boolean;
  /** Pinned by the user or the runtime (the plan definitions); pinned messages are never compactable. */
  pinned: boolean;
}

/** The instructions, the user's words and the runtime's own records: compaction must never lose or alter them. */
const NON_COMPACTABLE_KINDS: ReadonlySet<ContextMessageKind> = new Set<ContextMessageKind>(['system', 'brief', 'question', 'answer', 'summary', 'pinned', 'directive']);

/** The flags a message of `kind` starts with: only conversation turns and stubs are compactable. */
export function defaultFlags(kind: ContextMessageKind): MessageFlags {
  return { compactable: !NON_COMPACTABLE_KINDS.has(kind), pinned: kind === 'pinned' };
}

/** A message the user (or runtime) pinned: kept verbatim through every compaction. */
export function pinFlags(): MessageFlags {
  return { compactable: false, pinned: true };
}
