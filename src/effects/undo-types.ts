/** What a tool needs to reverse one of its calls later: plain JSON, captured right after the call ran. */
export type UndoDescriptor = Record<string, unknown>;

/** How applying an undo went. */
export interface UndoOutcome {
  ok: boolean;
  message?: string;
}

/** What `applyUndo` is given besides the descriptor. */
export interface UndoContext {
  agentName: string;
  instanceId: string;
  /** The run and call that made the effect. */
  runId: string;
  callId: string;
  effectId: string;
  signal: AbortSignal;
}

/** Collection of the effect log. */
export const EFFECTS_COLLECTION = 'effects';

/** `available`: can be undone; `unavailable`: its tool cannot undo it; `undone` / `undo_failed`: an undo was tried. */
export type EffectStatus = 'available' | 'unavailable' | 'undone' | 'undo_failed';

/** One entry of the append-only effect log (collection `effects`, key `effectId`). */
export interface EffectLogEntry {
  effectId: string;
  /** `effect`: a mutating call ran; `undo`: an undo was applied to `undoOf`. */
  kind: 'effect' | 'undo';
  agentName: string;
  instanceId: string;
  runId: string;
  callId: string;
  tool: string;
  /** Epoch ms. */
  at: number;
  /** Absent when the tool cannot undo the call (or capturing its descriptor failed). */
  descriptor?: UndoDescriptor;
  /**
   * sha-256 of the descriptor as captured (before `redact`); undo refuses a descriptor that no longer matches it, since
   * applying redacted undo data would write the redacted content back.
   */
  descriptorHash?: string;
  status: EffectStatus;
  /** Epoch ms after which the undo data is no longer honoured (`undo: { retentionMs }`). */
  expiresAt?: number;
  /** For `undo` entries: the effect undone. */
  undoOf?: string;
  message?: string;
  /** Order of appends within this process, so effects of one millisecond keep their order. */
  sequence: number;
}

/** Whose effects a `callId` or `since` target covers: this agent instance's (default), or every instance of the agent. */
export type UndoScope = 'instance' | 'agent';

/**
 * What `agent.undo` reverses: a run's effects (or one call of it), one call by its id, or every effect since a time
 * (epoch ms). `callId` alone must name a call of exactly one run (provider call ids repeat across runs).
 */
export type UndoTarget =
  | { runId: string; callId?: string }
  | { callId: string; scope?: UndoScope }
  | { since: number; scope?: UndoScope };

export type UndoResultStatus = 'undone' | 'failed' | 'unavailable' | 'already_undone' | 'expired';

export interface UndoResult {
  effectId: string;
  callId: string;
  tool: string;
  status: UndoResultStatus;
  message?: string;
}

/** One result per effect, newest first; a failure never stops the others. */
export interface UndoReport {
  results: UndoResult[];
}

/** `createAigent({ undo })`. */
export interface UndoOptions {
  /** How long undo data is honoured after the call (default: forever). */
  retentionMs?: number;
}

/** A mutating call's undo data as the executor captured it. */
export interface CapturedEffect {
  callId: string;
  tool: string;
  descriptor?: UndoDescriptor;
  /** See `EffectLogEntry.descriptorHash`. */
  descriptorHash?: string;
  /** Why there is no descriptor when capturing it failed. */
  message?: string;
}
