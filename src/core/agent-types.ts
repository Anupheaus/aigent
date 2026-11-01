import type { UserFeedback } from '../feedback/feedback-records.js';
import type { Citation } from './citations.js';
import type { Usage } from '../providers/provider-types.js';
import type { PlanItemState, TodoItem } from '../planning/plan-schema.js';
import type { CompactionPolicy } from '../context/compaction-policy.js';
import type { CompressionOptions, PromptPreview } from '../compression/compressor-types.js';
import type { ResumeRunOptions } from '../resume/agent-resume.js';
import type { ApprovalDecision } from '../approvals/approval-types.js';
import type { ShapersSetting } from '../shapers/shaper-types.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { GuardrailDecisionRecord } from '../guardrails/guardrail-types.js';
import type { PlannedEffect } from '../effects/planned-effects.js';
import type { UndoReport, UndoTarget } from '../effects/undo-types.js';
import type { DelegatedUsage } from './delegation-types.js';
import type { Tool } from '../tools/tool-types.js';
import type { PluginToolsRef } from '../plugins/plugin-types.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import type { StreamRun } from './event-stream.js';
import type { RunCallbacks } from './run-callbacks.js';
import type { Chat, ChatOptions } from '../chat/chat-types.js';
import type { MemoryOptions } from '../memory/memory-types.js';
import type { ModelSettings } from './model-settings.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import type { TaskInput, TaskLimits } from './task-input.js';
import type { ModelRoutes } from '../routing/routing-types.js';

export interface AgentDefinition {
  /** Unique, required; keys all stored data for this agent. */
  name: string;
  /**
   * `provider:model`, e.g. `anthropic:claude-sonnet-5-5`, or routes (`{ default, cheap?, capable?, fallback? }`): each
   * run then uses `default` unless its `routingPriority` or the learned statistics (`createAigent({ learning: {
   * routing } })`) pick another; the decision is stored on the run record as `route`.
   */
  model: string | ModelRoutes;
  persona?: string;
  skillset?: string;
  /** The environment the consumer places the agent in. */
  context?: string;
  /** The agent's tools; `pluginTools('<plugin>')` stands for every tool of a registered plugin (resolved by `ai.agent`). */
  tools?: (Tool | PluginToolsRef)[];
  /** Defaults for every task; a task's own limits win field by field. */
  limits?: TaskLimits;
  /** Model settings for every task; a task's own settings win field by field, and these win over `createAigent`'s. */
  modelSettings?: ModelSettings;
  /** Human version label (e.g. `2024-06-prompt-b`), stored on run records and part of `agentVersion`. */
  version?: string;
  /** Overrides for the retry, first-event timeout and fallback policy (see `DEFAULT_RESILIENCE_POLICY`). */
  resilience?: Partial<ResiliencePolicy>;
  /** `provider:model` strings tried in order when a turn's model is exhausted; each turn starts again at `model`. */
  fallbackModels?: string[];
  /** Supply to restore a known instance; generated otherwise. */
  instanceId?: string;
  /**
   * Ask the agent for feedback: the `previous` outcome field on tool calls, the `aigent_feedback` tool and the
   * directive instructions. Wins over `createAigent({ enableFeedback })`; default on unless `NODE_ENV` is `production`.
   */
  enableFeedback?: boolean;
  /**
   * Shaping of `lossy-ok` tool results: `'off'`, or `{ allow: [names] }` for only those built-in shapers. Default: every
   * built-in shaper. Verbatim results are never shaped whatever this says. A task's own `shapers` wins.
   */
  shapers?: ShapersSetting;
  /** False removes the built-in `todo` tool (the agent's own todo list). Default true. */
  todo?: boolean;
  /**
   * When the run compacts its history (fractions of the usable prompt budget): defaults
   * `{ compactAt: 0.75, compactTo: 0.45, keepRecent: 4, minSavingTokens: 500, minTurnsBetween: 3 }`. Validated at `ai.agent`.
   */
  compaction?: Partial<CompactionPolicy>;
  /** `provider:model` that writes compaction summaries (default: the agent's own model and fallbacks). */
  compactionModel?: string;
  /**
   * Prompt compression with a pluggable `Compressor` (none ships with the library). Static fields are compressed once
   * and cached; `compressible` tool results as they are committed. Part of the agent version.
   */
  compression?: CompressionOptions;
  /**
   * Memory written only alongside tool calls (the `memory` field) and recalled into the volatile block. Replaces
   * `createAigent({ memory })` whole; false turns it off for this agent. Off by default; needs a store.
   */
  memory?: MemoryOptions | boolean;
}

export interface TaskUsage extends Usage {
  /** Model requests made (LLM round trips). An `aigent_multi` call is part of the turn that requested it, however many inner calls it holds. */
  turns: number;
  /**
   * Tool calls actually executed, counting each call inside `aigent_multi` (the wrapper itself is not counted).
   * Calls refused by `maxToolCalls` and `aigent_feedback` calls (commentary, outside the budget) are not counted. A
   * batch tool call counts once, whatever its item count.
   */
  toolCalls: number;
  /**
   * `toolCalls / turns` (0 when no turn was made): how much tool work each model round trip achieved. Higher is more
   * efficient, since every turn re-sends the conversation; batch tools and `aigent_multi` raise it.
   */
  toolCallsPerTurn: number;
  /** Provider calls retried after a failure before their first event. */
  retries: number;
  /** Times a turn moved on to a fallback model. */
  fallbacks: number;
  durationMs: number;
  /**
   * Largest prompt the run sent, in tokens: the provider's reported input tokens where it reported them, the
   * calibrated estimate otherwise. Absent when the run made no request.
   */
  contextTokensPeak?: number;
  /** Compactions the run made; absent when it made none. */
  compactions?: number;
  /** Input plus output tokens spent writing compaction summaries (already included in `inputTokens`/`outputTokens`). */
  compactionTokens?: number;
  /** Estimated prompt tokens removed by the run's compactions. */
  compactionTokensSaved?: number;
  /** What the sub-runs this run delegated to used (not included in the counts above); absent when it delegated nothing. */
  delegated?: DelegatedUsage;
  /** Turns replayed from the response cache (`learning.responseCache`), at zero tokens; absent when none was. */
  cachedResponses?: number;
}

export interface TaskResult {
  status: TaskStatus;
  answer: string;
  runId: string;
  /** Stable id of this answer; pass it to `ai.feedback` to rate the response. */
  responseId: string;
  agentName: string;
  instanceId: string;
  usage: TaskUsage;
  /**
   * Every tool failure with full detail, including failures inside successful aggregate results: failed batch items
   * (`details.itemIndex`) and failed `aigent_multi` inner calls (`details.callId`, `details.tool`), each with the
   * enclosing call's id in `details.parentCallId`.
   */
  errors: ToolErrorDetail[];
  /** Set when status is 'failed'. */
  failure?: string;
  /** Set when the run was stopped ('stopped' → graceful, 'cancelled' → immediate). */
  stopMode?: 'graceful' | 'immediate';
  /** The task's plan with final statuses and evidence, when one was supplied. */
  plan?: PlanItemState[];
  /** The agent's todo list at the end, when it kept one. */
  todo?: TodoItem[];
  /** The answer parsed and validated against the task's `output` schema, when it has one. */
  output?: unknown;
  /** Every guardrail decision that was not a plain allow (rewrites, blocks, warnings, failing checks), in order. */
  guardrails?: GuardrailDecisionRecord[];
  /** Dry runs only: what the mutating calls would have done, in order (empty when nothing would change). */
  plannedEffects?: PlannedEffect[];
  /**
   * The passages the answer cites with `[[cite:<chunkId>]]` markers (stripped from `answer`), resolved against what the
   * run's tools returned (the knowledge pack), in order of first citation. Absent when the answer cites nothing.
   */
  citations?: Citation[];
  /** Shortcut for `ai.feedback({ responseId, ...feedback })`. Not enumerable, so the result stays plain data. */
  feedback(feedback: Omit<UserFeedback, 'responseId'>): Promise<void>;
}

/** A task result as the loop builds it, before `feedback` is attached. */
export type TaskResultData = Omit<TaskResult, 'feedback'>;

export interface StopOptions {
  /** 'graceful' finishes the current turn; 'immediate' aborts now. Default 'immediate'. */
  mode?: 'graceful' | 'immediate';
  /**
   * Immediate stops only: also abort tools with side effects. Without it they finish (bounded by their own timeout)
   * so writes are not left half-done; read-only tools are always aborted.
   */
  force?: boolean;
}

/** The run's events as callbacks (`onActivity`, `onThinking`, `onToolActivity`): each sees exactly the events. */
export type TaskRun = StreamRun<AigentEvent, TaskResult> & RunCallbacks & {
  runId: string;
  /** Repeated calls, and calls after the run settled, are no-ops. */
  stop(options?: StopOptions): void;
  /** Alias for `stop({ mode: 'immediate' })`. */
  cancel(): void;
  /**
   * Delivers `text` as a user message at the next safe boundary (after the in-flight tool results, before the next model
   * request), with no extra request. Text that arrives after the last request is not delivered (a `warning` says so).
   */
  steer(text: string): void;
};

export interface Agent {
  name: string;
  instanceId: string;
  /**
   * Lowercase hex sha-256 of everything behaviour-relevant in the definition (model, prompt parts, effective settings,
   * limits, version label, tool contracts, library version); independent of `name` and `instanceId`. Stored on run records.
   */
  agentVersion: string;
  /** Validates `input` synchronously (throws `invalid_input`), then runs the task in the background. */
  task(input: TaskInput): TaskRun;
  /**
   * The exact system prompt, brief and tools a task with `input` would start with (compression applied), and every
   * compressed field before and after. Calls no provider. Rejects with `invalid_input` for an invalid input.
   */
  preview(input?: TaskInput): Promise<PromptPreview>;
  /**
   * A stateful conversation: streaming replies, a UI-ready conversation model (snapshot and gapless patches) and,
   * with a store, persistence by `sessionId`. Validates `options` synchronously (throws `invalid_input`).
   */
  chat(options?: ChatOptions): Chat;
  /**
   * Settles once the instance is open: with `createAigent({ resume })` and an explicit `instanceId` its lease is taken
   * (rejects `instance_locked` while another runtime holds it) and its interrupted runs are loaded. Resolves at once
   * without `resume`, or for a generated instance id (whose lease is taken by its first run).
   */
  ready: Promise<void>;
  /**
   * Continues the latest interrupted run (or `runId`) from its last checkpoint: the identical next request, finished
   * calls never run again, started ones per their tool's `resume` policy. Undefined when there is nothing to resume
   * (or `resume` is off). Throws `invalid_input` before `ready` has resolved.
   */
  resume(options?: ResumeRunOptions): TaskRun | undefined;
  /**
   * Decides a pending approval request (`approval-request` event): `allow_once`, `allow_always` (adds a rule for the
   * runtime, scoped by `scope`) or `deny`. Works for requests a restored run is still waiting on, before `resume()`.
   * Resolves once the decision is in the audit trail; rejects `invalid_input` for an unknown request.
   */
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
  /**
   * Reverses recorded effects (a run's or one call of it, one call by id, or every one since a time) newest first through
   * their tools' `applyUndo`, with one result per effect: `undone`, `failed` (the rest still run), `unavailable` (the
   * tool cannot undo it, or its undo data was changed by `redact`), `already_undone` or `expired` (past
   * `undo.retentionMs`). Each undo is itself recorded. `callId` and `since` cover this instance's effects unless
   * `scope: 'agent'`; a bare `callId` that matches calls of several runs is refused (`invalid_input`).
   */
  undo(target: UndoTarget): Promise<UndoReport>;
  /**
   * With `resume`: waits for this agent object's task runs, then releases its instance's lease, so another runtime can
   * take the instance over at once (a later run here takes it again). `ai.close()` releases every instance.
   */
  close(): Promise<void>;
}

export const DEFAULT_LIMITS = { maxTurns: 25, maxToolCalls: 100 } as const;
