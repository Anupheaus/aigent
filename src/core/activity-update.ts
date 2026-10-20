/** What the agent is doing; `recalling` and `verifying` are reserved for later slices. */
export const ACTIVITY_PHASES = [
  'queued', 'recalling', 'planning', 'thinking', 'calling_tools', 'waiting_for_user', 'writing', 'verifying', 'finishing', 'done', 'failed', 'cancelled',
] as const;

export type ActivityPhase = typeof ACTIVITY_PHASES[number];

/** A tool call in flight. */
export interface ActivityToolCall {
  tool: string;
  callId: string;
  startedAt: number;
  /** Batch tools: items finished so far, from the tool's activity view. */
  itemsDone?: number;
  itemsTotal?: number;
  /** A call of a delegated sub-run (its `callId` is `<parentCallId>/<own id>`), rolled up into this run's list. */
  delegatedTo?: { agentName: string; parentCallId: string };
}

export interface ActivityProgress {
  planDone: number;
  planTotal: number;
  todoDone: number;
  todoTotal: number;
  /** Acceptance criteria the agent reported met (0 until criteria reporting arrives). */
  criteriaMet: number;
  criteriaTotal: number;
  /** The model request in progress (1-based), or the last one once finished. */
  turn: number;
  maxTurns: number;
}

/**
 * One activity update: the same shape and order for `agent.task()` and chat turns. Derived from loop events (no
 * model call of its own), throttled, with heartbeats while busy; the terminal phase is always last.
 */
export interface ActivityUpdate {
  /** 1-based, gapless per run. */
  seq: number;
  runId: string;
  /** The chat's agent message this run is producing. */
  messageId?: string;
  phase: ActivityPhase;
  /** Derived (e.g. "Running 3 tools") or the agent's own `::aigent status` text. */
  statusText: string;
  current?: ActivityToolCall[];
  progress?: ActivityProgress;
  elapsedMs: number;
  tokens: { input: number; output: number };
  /** 0 without a price for the run's model. */
  costUsd: number;
  /** True for keep-alive updates that report no change. */
  heartbeat: boolean;
}
