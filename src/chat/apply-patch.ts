import type { ConversationState } from './conversation.js';
import type { Patch, PatchBody } from './patches.js';
import { reduceConversation } from './reduce-conversation.js';

export type PatchListener = (patch: Patch) => void;

export interface SubscribeOptions {
  /** Replays every recorded patch with `seq >= fromSeq` first (pass your state's `seq + 1` after a reconnect). */
  fromSeq?: number;
}

/** A session's patch stream and the snapshot folded from it; the only way a conversation changes. */
export interface PatchLog {
  /** Stamps the next seq and time, folds it into the snapshot, records it, then tells subscribers. */
  append(body: PatchBody): Patch;
  state(): ConversationState;
  /** Recorded patches with `seq >= fromSeq` (all by default). */
  patches(fromSeq?: number): Patch[];
  subscribe(listener: PatchListener, options?: SubscribeOptions): () => void;
}

export interface CreatePatchLogParams {
  /** The empty state of this session. */
  base: ConversationState;
  /** Stored patches to replay (a reopened session). */
  history?: Patch[];
  /** A stored state at some seq of `history`: only the later patches are folded into it. */
  snapshot?: ConversationState;
  now(): number;
}

/** Calls a subscriber; a UI bug must never break the conversation it is watching. */
function notify(params: { listener: PatchListener; patch: Patch }): void {
  const { listener, patch } = params;
  try {
    listener(patch);
  } catch {
    // Subscribers are consumer code; their failures are theirs to report, the session carries on.
  }
}

export function createPatchLog(params: CreatePatchLogParams): PatchLog {
  const { base, history = [], snapshot, now } = params;
  const recorded: Patch[] = [...history];
  // The reducer skips patches at or below the snapshot's seq, so folding the whole history onto it is exact.
  let state = history.reduce(reduceConversation, snapshot ?? base);
  const listeners = new Set<PatchListener>();

  function append(body: PatchBody): Patch {
    const patch = { ...body, seq: state.seq + 1, at: now() } as Patch;
    // Reduced before it is recorded, so a patch the reducer refuses never reaches the stream or the store.
    state = reduceConversation(state, patch);
    recorded.push(patch);
    for (const listener of [...listeners]) notify({ listener, patch });
    return patch;
  }

  function patches(fromSeq = 1): Patch[] {
    return recorded.filter(({ seq }) => seq >= fromSeq);
  }

  function subscribe(listener: PatchListener, options: SubscribeOptions = {}): () => void {
    const { fromSeq } = options;
    if (fromSeq != null) for (const patch of patches(fromSeq)) notify({ listener, patch });
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { append, state: () => state, patches, subscribe };
}
