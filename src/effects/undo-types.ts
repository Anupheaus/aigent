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
  status: EffectStatus;
  /** Epoch ms after which the undo data is no longer honoured (`undo: { retentionMs }`). */
  expiresAt?: number;
  /** For `undo` entries: the effect undone. */
  undoOf?: string;
  message?: string;
  /** Order of appends within this process, so effects of one millisecond keep their order. */
  sequence: number;
}

/** What `agent.undo` reverses: one call's effects, a run's, or every effect since a time (epoch ms). */
export type UndoTarget = { callId: string } | { runId: string } | { since: number };

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
  /** Why there is no descriptor when capturing it failed. */
  message?: string;
}
