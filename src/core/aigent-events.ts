import type { ApprovalDecider, ApprovalDecisionKind, ApprovalRequest } from '../approvals/approval-types.js';
import type { Directive } from '../streaming/directive-parser.js';
import type { ActivityUpdate } from './activity-update.js';
import type { ToolActivityView } from '../tools/tool-types.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import type { Usage } from '../providers/provider-types.js';
import type { QueueReason } from '../scheduler/scheduler-types.js';
import type { PlanItemState, TodoItem } from '../planning/plan-schema.js';
import type { GuardrailDecisionRecord } from '../guardrails/guardrail-types.js';
import type { PlannedEffect } from '../effects/planned-effects.js';

/** Every way a run can end. */
export const TASK_STATUSES = ['completed', 'incomplete', 'failed', 'cancelled', 'stopped', 'limit_reached'] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

/** The stages of a compaction, in the order they run. */
export type CompactionStage = 'stubbed' | 'deduped' | 'summarised';

export type AigentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  /** A model turn's streamed reasoning ended; `text` is all of it (emitted only after `thinking-delta` events). */
  | { type: 'thinking-done'; text: string }
  /**
   * The text the last model turn streamed (`text`, exactly as its `text-delta` events gave it) is withdrawn: the answer
   * was sent back to be fixed (no `replacement`), or the output guardrails changed it (`replacement` is the answer).
   */
  | { type: 'text-retracted'; text: string; replacement?: string; reason: string }
  /** What the agent is doing now: derived from these events, throttled, with heartbeats; the terminal update comes just before `done`. */
  | { type: 'activity'; update: ActivityUpdate }
  | { type: 'tool-call'; callId: string; name: string; args: unknown }
  | { type: 'tool-activity'; callId: string; view: ToolActivityView }
  | { type: 'tool-result'; callId: string; envelope: ToolEnvelope }
  | { type: 'directive'; directive: Directive }
  /** `cachedResponse`: the turn was replayed from the response cache, at no cost (its usage is zero). */
  | { type: 'usage'; usage: Usage; cachedResponse?: true }
  | { type: 'warning'; message: string }
  /** A provider call failed before any event and will be retried after `delayMs`; `attempt` is 1 for the first retry. */
  | { type: 'retry'; attempt: number; delayMs: number; model: string; reason: string }
  /** `from` (a `provider:model`) is exhausted; the turn continues on fallback model `to`. */
  | { type: 'fallback'; from: string; to: string; reason: string }
  /** The provider call is waiting for the scheduler; emitted only when it could not start at once. */
  | { type: 'queued'; position: number; reason: QueueReason; waitMs?: number }
  /** The plan changed (through `plan_complete` or an `::aigent plan` directive); `items` is the whole plan, `changed` the ids that changed. */
  | { type: 'plan-update'; items: PlanItemState[]; changed: string[] }
  /** The agent's todo list changed; `items` is the whole list, `changed` the ids that changed. */
  | { type: 'todo-update'; items: TodoItem[]; changed: string[] }
  /**
   * One compaction stage was applied: stale tool results stubbed, duplicates replaced, or old turns summarised.
   * Token figures are calibrated estimates of the whole prompt; `summaryTokens` is the new summary's size.
   */
  | { type: 'compaction'; stage: CompactionStage; tokensBefore: number; tokensAfter: number; messagesAffected: number; summaryTokens?: number; costUsd?: number }
  /** A call needs a person's approval; the run waits for `agent.approve(request.requestId, decision)`. */
  | ({ type: 'approval-request' } & ApprovalRequest)
  /** An approval was decided: by a rule, by the user, or by the run's policy (unattended, or stopped while waiting). */
  | { type: 'approval-decision'; requestId: string; callId: string; tool: string; decision: ApprovalDecisionKind; by: ApprovalDecider; note?: string }
  /** A guardrail rewrote, blocked or warned about something (or its check failed); stored on the run and its steps. */
  | ({ type: 'guardrail' } & GuardrailDecisionRecord)
  /** Dry runs: what a call (or the calls inside it) would have done. */
  | { type: 'planned-effects'; callId: string; effects: PlannedEffect[] }
  | { type: 'error'; message: string }
  /** An event of a sub-run started by this run's `delegate` call `callId` (the sub-run's own `runId`). */
  | { type: 'delegated'; callId: string; agentName: string; runId: string; event: AigentEvent }
  /** Always last, emitted after the run's records are written; `responseId` is the id to rate the answer with. */
  | { type: 'done'; status: TaskStatus; responseId: string };
