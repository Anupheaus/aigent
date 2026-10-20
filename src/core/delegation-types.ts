import type { Usage } from '../providers/provider-types.js';
import type { AigentEvent } from './aigent-events.js';
import type { TaskRun } from './agent-types.js';
import type { TaskInput } from './task-input.js';

/** Deepest chain of delegations allowed (a top-level run is depth 0). */
export const MAX_DELEGATION_DEPTH = 3;

/** The run (and call) that started a delegated sub-run: `TaskInput.parent`, stored as `RunRecord.parent`. */
export interface RunParent {
  agentName: string;
  instanceId: string;
  runId: string;
  /** The parent's `delegate` call. */
  callId: string;
  /** 1 for a sub-run of a top-level run, at most `MAX_DELEGATION_DEPTH`. */
  depth: number;
  /** Agent names from the top-level run down to the parent (inclusive), so a delegation cycle can be refused. */
  ancestors?: string[];
}

/** What a run's delegated sub-runs used, rolled up into `TaskUsage.delegated` (not into its own token counts). */
export interface DelegatedUsage {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  turns: number;
  toolCalls: number;
  /** Present when the sub-runs' models have prices. */
  costUsd?: number;
}

/** A sub-run started for a tool, with how to price its usage at its own model's price. */
export interface StartedSubRun {
  run: TaskRun;
  /** Undefined without a price for the sub-run's model. */
  price(usage: Usage): number | undefined;
}

/** Starts a run of the runtime's agent with this name (the latest `ai.agent` with it); undefined when there is none. */
export type StartSubRun = (request: { agentName: string; input: TaskInput }) => StartedSubRun | undefined;

/** One admitted sub-run: the tool calls reserved for it from the calling run's budget, released when it ends. */
export interface DelegationSlot {
  /** The sub-run's `maxToolCalls` (what was reserved). */
  toolCalls: number;
  /** Ends the reservation (the sub-run's actual calls count through `addUsage`). Call once, after `addUsage`. */
  release(): void;
}

/** The calling run's side of delegation, given to tools that declare `startsSubRuns` as `ToolContext.delegation`. */
export interface DelegationContext {
  /** The calling run's depth (0 for a top-level run). */
  depth: number;
  /** Agent names from the top-level run down to the calling run (inclusive). */
  ancestors: string[];
  /**
   * Admits one sub-run against the calling run's limits: at most `maxConcurrent` in flight at once, and up to
   * `wantedToolCalls` reserved from what is left of its `maxToolCalls` (delegated calls count against it). Says why
   * when either is spent.
   */
  admit(request: { maxConcurrent: number; wantedToolCalls: number }): DelegationSlot | { refused: 'concurrency' | 'budget' };
  /** Starts the sub-run, linked to this call (`parent`); undefined when no agent has that name. */
  start(request: { agentName: string; input: TaskInput }): StartedSubRun | undefined;
  /** Passes a sub-run event into this run's stream (as a `delegated` event), e.g. for activity roll-up. */
  forward(params: { agentName: string; runId: string; event: AigentEvent }): void;
  /** Adds a finished sub-run's usage to this run's `usage.delegated`. */
  addUsage(usage: Omit<DelegatedUsage, 'runs'>): void;
  /** Aborts when the calling run is stopped immediately (a sub-run is then cancelled too). */
  runSignal: AbortSignal;
  /** Aborts on any stop of the calling run, graceful included (a sub-run then stops gracefully). */
  stopSignal: AbortSignal;
  isUnattended: boolean;
  priority: 'interactive' | 'background';
}

/** The run-wide part of a `DelegationContext`; the dispatcher binds each call (`forward`, `start`) to it. */
export interface RunDelegation {
  depth: number;
  /** Agent names from the top-level run down to this run (inclusive). */
  ancestors: string[];
  /** Sub-runs of this run in flight (mutable, shared by its calls). */
  inFlight: number;
  startSubRun?: StartSubRun;
  isUnattended: boolean;
  priority: 'interactive' | 'background';
}
