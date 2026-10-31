import type { RunParent } from '../core/delegation-types.js';
import type { TaskUsage } from '../core/agent-types.js';
import type { TaskStatus } from '../core/aigent-events.js';
import type { ModelSettings } from '../core/model-settings.js';
import type { ProviderSettings } from '../providers/provider-types.js';
import type { UserRating } from '../feedback/feedback-records.js';
import type { ToolErrorCategory } from '../tools/tool-error-detail.js';
import type { CompressionRecord } from '../compression/compressor-types.js';
import type { GuardrailDecisionRecord } from '../guardrails/guardrail-types.js';
import type { PlannedEffect } from '../effects/planned-effects.js';

/** Version of every stored telemetry record's shape; bumped on any incompatible change. */
export const RUN_RECORD_SCHEMA_VERSION = 1;

/** How the agent was used. Chat is a later mode; every record says which one wrote it. */
/** `task` for `agent.task()`, `chat` for one chat reply (a turn group). */
export type RunMode = 'task' | 'chat';

/** Who wrote a record and when; carried by every stored telemetry record so any record can be sliced and purged alone. */
export interface RecordMeta {
  schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  runId: string;
  agentName: string;
  instanceId: string;
  mode: RunMode;
  /** The agent's version hash (see `Agent.agentVersion`). */
  agentVersion: string;
  /** The task's `scope`, stored untouched and never interpreted. */
  scope?: Record<string, string>;
  /** Epoch ms when the record was written; `purge({ before })` compares against it. */
  recordedAt: number;
  /** Epoch ms after which a store may drop the record (`createAigent({ retention })`). */
  expiresAt?: number;
}

/** The runtime-only settings: they shape the run but are never sent to a provider. */
export type RuntimeOnlySettings = Pick<ModelSettings, 'contextSize' | 'showThinking'>;

/** A fallback model the run used, with what it was sent. */
export interface RunRecordFallback {
  /** `provider:model`. */
  model: string;
  /** The settings this model was sent (its own `providerOptions` entry included); `{}` when none. */
  settings: ProviderSettings;
  /** Resolved settings this model's provider left out. */
  droppedSettings?: (keyof ProviderSettings)[];
}

/** Who reported a step's outcome: an `::aigent outcome` directive or the `previous` field of the next call. */
export type OutcomeSource = 'directive' | 'previous';

/** The agent's own verdict on a tool step. */
export interface StepOutcome {
  /** True when the step found what the agent was looking for. */
  success: boolean;
  /** Short description of the result; `''` when content capture is off. */
  answer: string;
  source: OutcomeSource;
}

/** What one shaper did to a result's size. */
export interface ShapedStepRecord {
  shaper: string;
  tokensBefore: number;
  tokensAfter: number;
}

/** What a call's `memory` notes came to (their text is in the `memory` collection, never in the trace). */
export interface MemoryStepRecord {
  saved: number;
  /** Invalid, over the per-call limit, or not written. */
  rejected: number;
}

/** One tool call of a run, in start order. Inner `aigent_multi` calls are steps too, linked by `parentCallId`. */
export interface TraceStep {
  /** 0-based position in start order. */
  index: number;
  /** 1-based model request that asked for the call. */
  turn: number;
  callId: string;
  /** The `aigent_multi` call this inner call belongs to. */
  parentCallId?: string;
  tool: string;
  /** First 120 characters of the arguments' canonical JSON; with content capture off, the argument shape only. */
  argsSummary: string;
  /**
   * Content-free digest of the full arguments, salted per run (see `digestArgs`): equal within a run exactly when the
   * arguments are equal. Absent on records written before it existed.
   */
  argsHash?: string;
  /** The arguments as validated, only when content capture is on. */
  args?: unknown;
  ok: boolean;
  errorCategory?: ToolErrorCategory;
  errorCode?: string;
  /** Batch calls: failed items. */
  itemFailures?: number;
  /** Batch calls: items in the call. */
  itemTotal?: number;
  /** Set for cacheable tools while the cache is on: true when the result was served from the tool-result cache. */
  cacheHit?: boolean;
  /** On a cache hit: the original call's duration, which the hit saved. */
  savedMs?: number;
  /** Shapers that changed what the model saw, with estimated tokens before and after each. */
  shaped?: ShapedStepRecord[];
  /** UTF-8 bytes of the full result (or error), before truncation. */
  resultBytes: number;
  /** Estimated tokens of the full result (or error), before truncation. */
  resultTokens: number;
  /** The model was shown a truncation marker instead of the result. */
  truncated: boolean;
  durationMs: number;
  /** Epoch ms when the call started. */
  startedAtMs: number;
  outcome?: StepOutcome;
  /** Guardrail decisions about this call and its result (messages only with content capture on). */
  guardrails?: GuardrailDecisionRecord[];
  /** The call changed something that `agent.undo` can reverse (its undo data is in the effect log). */
  undoable?: boolean;
  /** The call carried memory notes (top-level calls only). */
  memory?: MemoryStepRecord;
}

/** Where a run's time went, in milliseconds. */
export interface RunTimings {
  /** Epoch ms when the run started. */
  startedAt: number;
  /** From the start to the first streamed text, thinking or tool call. */
  firstTokenMs?: number;
  durationMs: number;
  /** Streaming model responses, excluding time spent queued. */
  modelMs: number;
  /** Sum of the top-level tool calls' durations (they may overlap the stream and each other). */
  toolMs: number;
  /** Waiting for the scheduler to admit provider calls. */
  queuedMs: number;
}

/** The agent's own outcome claims over the run's steps. */
export interface OutcomeSummary {
  claimedSuccess: number;
  claimedFailure: number;
}

/** How the run used its tools, from its trace (wrappers and commentary left out). */
export interface ToolUse {
  /** Tool calls that did work, inner `aigent_multi` calls included. */
  calls: number;
  /** Work items: a batch call's items, one for any other call. */
  items: number;
  /** Calls with the same tool and arguments (by `argsHash`) as an earlier call of the run. */
  repeats: number;
}

/** A plan item as stored: id and status always; the text fields only with content capture on. */
export interface StoredPlanItem {
  id: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  label?: string;
  description?: string;
  acceptanceCriteria?: string[];
  evidence?: string;
}

/** A todo item as stored: id and status always; the text fields only with content capture on. */
export interface StoredTodoItem {
  id: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  label?: string;
  description?: string;
}

/** One document in the `runs` collection, keyed by run id. */
export interface RunRecord extends RecordMeta {
  /** Stable id of the run's answer, used by `ai.feedback`. */
  responseId: string;
  /** The agent definition's human version label, when it has one. */
  version?: string;
  label?: string;
  /** The agent's `provider:model`. */
  model: string;
  /**
   * The settings the agent's model was sent: resolved task > agent > runtime > provider, then filtered for its
   * provider, with only that provider's `providerOptions` entry. `{}` when none. `providerOptions` are stored as
   * configured unless a `redact` hook changes them.
   */
  settings: ProviderSettings;
  /** Resolved settings the agent's provider left out (each also produced a `warning`). */
  droppedSettings?: (keyof ProviderSettings)[];
  /** `contextSize` / `showThinking` when set: run configuration that is never sent. */
  runtimeSettings?: RuntimeOnlySettings;
  /** Fallback models the run actually used, in the order it reached them. */
  fallbacks?: RunRecordFallback[];
  /** No user was available (`TaskInput.unattended`). */
  unattended: boolean;
  status: TaskStatus;
  usage: TaskUsage;
  timings: RunTimings;
  /** Trace steps, inner `aigent_multi` calls included. */
  stepCount: number;
  /** Tool failures, failed batch items and failed inner calls included (as in `TaskResult.errors`). */
  failureCount: number;
  /** The task text, only when content capture is on. */
  task?: string;
  /** The final answer, only when content capture is on. */
  answer?: string;
  /** Outcomes the agent reported on its steps (`previous` and `outcome` directives). */
  outcomeSummary: OutcomeSummary;
  toolUse: ToolUse;
  /** The latest user rating (`ai.feedback`), copied here so scoring needs no join; it overrides the agent's claims. */
  userVerdict?: UserRating;
  /** The task's plan with final statuses, when one was supplied. */
  plan?: StoredPlanItem[];
  /** The agent's todo list at the end, when it kept one. */
  todo?: StoredTodoItem[];
  /** Every compression the run used (prompt fields and tool results), when the agent compresses. Sizes only, no text. */
  compression?: CompressionRecord[];
  /** Every non-allow guardrail decision of the run (messages only with content capture on). */
  guardrails?: GuardrailDecisionRecord[];
  /** A dry run (`TaskInput.dryRun`): nothing was changed. Set whatever `disableTelemetry` says about other records. */
  dryRun?: true;
  /** Dry runs: the planned effects (targets, summaries and texts only with content capture on). */
  plannedEffects?: PlannedEffect[];
  /** A delegated sub-run: the run and `delegate` call it worked for. */
  parent?: RunParent;
  /** With memory on: notes written by the run's tool calls (new entries and merges). */
  memorySaved?: number;
  /** With memory on: entries the cap evicted while saving them. */
  memoryEvicted?: number;
}

/** One document in the `traces` collection, keyed by run id. */
export interface TraceRecord extends RecordMeta {
  steps: TraceStep[];
}

/** A run with its steps, as `ai.trace(runId)` returns it. */
export interface RunTrace {
  run: RunRecord;
  steps: TraceStep[];
}
