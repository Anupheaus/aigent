import type { z } from 'zod';
import type { ContentKind, Fidelity } from '../shapers/shaper-types.js';
import type { JsonSchema } from '../providers/provider-types.js';
import type { ApprovalRisk, RequiresApproval } from '../approvals/approval-types.js';
import type { ExecutedToolCall } from './execute-tool-call.js';
import type { DelegationContext } from '../core/delegation-types.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { DryRunOutput, PlannedEffect } from '../effects/planned-effects.js';
import type { CapturedEffect, UndoContext, UndoDescriptor, UndoOutcome } from '../effects/undo-types.js';

export interface ToolContext {
  agentName: string;
  instanceId: string;
  runId: string;
  /** This call's id (the inner call's own id inside `aigent_multi`). */
  callId: string;
  /** Aborts when the run is stopped; long-running tools should honour it. */
  signal: AbortSignal;
  /**
   * `<runId>:<callId>`: the same for every execution of this call, including a re-run after a resume, so a tool with
   * side effects can pass it to a remote API to make the effect happen once.
   */
  idempotencyKey?: string;
  /** A dry run: a tool with side effects is asked for `dryRun` instead of `run`, and must change nothing. */
  dryRun?: boolean;
  /** Only for tools that declare `startsSubRuns` (the `delegate` tool): how to start linked sub-runs. */
  delegation?: DelegationContext;
}

/** How a resumed run treats a call that had started but not finished when the run was interrupted. */
export type ToolResumePolicy = 'rerun' | 'verify' | 'ask' | 'skip';

/** What `verify` found: whether the call's effect already happened, and the result to give the model if so. */
export interface ToolVerifyResult {
  done: boolean;
  result?: unknown;
}

/** One `aigent_multi` inner call, as the model wrote it. */
export interface InnerCall {
  id: string;
  tool: string;
  args: unknown;
}

/** Run-internal context given only to `aigent_multi`, so its inner calls take the run's dispatch path. */
export interface MultiToolContext extends ToolContext {
  /**
   * Runs one inner call exactly like a top-level call (guardrails, the `maxToolCalls` budget, approvals, the ledger
   * with its own idempotency key, the cache, dry runs and tracing). Never rejects.
   */
  runInnerCall(call: InnerCall): Promise<ExecutedToolCall>;
}

/** How many items a batch call carried and how many of them failed. */
export interface ItemCounts {
  total: number;
  failed: number;
}

export interface ToolOutcome {
  success: boolean;
  /** Short human explanation, e.g. 'Found 12 files'. */
  reason: string;
}

export interface ToolActivityView {
  title: string;
  detail?: string;
  icon?: string;
  progress?: { done: number; total: number };
}

export type DescribeActivity<TArgs> = (
  args: TArgs,
  outcome: Promise<ToolOutcome>,
) => ToolActivityView | Promise<ToolActivityView> | AsyncIterable<ToolActivityView>;

export interface Tool {
  name: string;
  description: string;
  argsSchema: z.ZodType;
  /** JSON schema derived from `argsSchema`: the strict subset unless `strict` is false. */
  jsonSchema: JsonSchema;
  /** Whether `jsonSchema` follows the strict subset; providers send the tool with strict decoding only when true. */
  strict: boolean;
  /** Same name + args always give the same result. */
  deterministic: boolean;
  /** Whether results may be cached (scope follows `deterministic`). */
  cache: boolean;
  cacheTtlMs?: number;
  /** Normalises arguments into the cache key (default: the arguments themselves), e.g. to ignore a formatting option. */
  cacheKey?(args: unknown): unknown;
  /**
   * A token that changes whenever the data behind a result changes (e.g. mtime + size, or a content hash). An entry is
   * served only while its stored token still matches.
   */
  validity?(args: unknown, context: ToolContext): Promise<string>;
  /** Contract version label; bump it to invalidate cached results. Part of the cache key and the agent version. */
  version?: string;
  /** Hash of the argument schema as defined (set by `defineTool`), so schema wrappers never change cache keys. */
  schemaHash?: string;
  /**
   * Deterministic cached tools: the namespace whose entries this tool shares. Every tool (in any agent or runtime on
   * the same store) with the same namespace, name, version, schema and description serves the others' results, so
   * use it only when same arguments really give the same bytes for all of them. Default: the requesting agent's own
   * namespace (`agent:<agentName>:<version>`), so same-named tools of different agents never collide.
   */
  cacheNamespace?: string;
  /** Deterministic cached tools: true shares entries in the `global` namespace with every agent (unless `cacheNamespace` is set). */
  sharedCache?: boolean;
  /**
   * Identity of this definition (set by `defineTool`, unique per process), part of the cache key of instance-scoped
   * (non-deterministic) entries so two definitions bound to different data never share results. Wrappers keep it.
   */
  definitionId?: string;
  /** What the result contains; shapers declare the kinds they may touch. */
  contentKind?: ContentKind;
  /** Absent means `verbatim`: nothing may alter the result. `lossy-ok` lets shapers for its `contentKind` run. */
  fidelity?: Fidelity;
  hasSideEffects: boolean;
  /**
   * Opt-in: string arguments that are exactly an alias issued earlier in the run (`F1`...) are replaced by the text
   * behind it before validation. Set it only for tools whose arguments are references the alias legend covers (paths,
   * ids); never for tools whose arguments are literal values (keys, cells, content).
   */
  acceptsAliases?: boolean;
  timeoutMs: number;
  maxResultTokens?: number;
  /** False keeps this tool's results out of compaction: never stubbed, deduplicated or summarised. Absent means true. */
  compactable?: boolean;
  /**
   * Lets a configured compressor shorten this tool's prose results when they are committed to history (original kept
   * by handle). `'allow-code'` also allows results that look like code, diffs or JSON. Absent means not compressible.
   */
  compressible?: boolean | 'allow-code';
  describeActivity: DescribeActivity<unknown>;
  run(args: unknown, context: ToolContext): Promise<unknown>;
  /** Optional aggregate outcome for the activity renderer; default is success. */
  summarise?(result: unknown): ToolOutcome;
  /**
   * After a crash: `rerun` runs the call again, `verify` asks `verify` first, `ask` needs an approval (refused in
   * unattended runs), `skip` gives the model a `skipped` failure. Default: `rerun` without side effects, else `ask`.
   */
  resume?: ToolResumePolicy;
  /** Says whether an interrupted call's effect already happened (required with `resume: 'verify'`). */
  verify?(args: unknown, context: ToolContext): Promise<ToolVerifyResult>;
  /** A person must approve the call first: always, by a predicate over the arguments, or a policy with its reason. */
  requiresApproval?: RequiresApproval;
  /** Shown with approval requests. */
  risk?: ApprovalRisk;
  /** Failures inside a successful aggregate result (batch items, `aigent_multi` calls), reported in `TaskResult.errors`. */
  nestedFailures?(result: unknown): ToolErrorDetail[];
  /** Item totals of a batch result, for tool telemetry (`defineBatchTool` sets it). */
  countItems?(result: unknown): ItemCounts;
  /**
   * Tools with side effects: what a call would do, without doing it (used in dry runs). Return the effects, or a
   * simulated result for the model plus the effects.
   */
  dryRun?(args: unknown, context: ToolContext): Promise<DryRunOutput>;
  /** Effects planned inside a result (the dry-run calls inside an `aigent_multi` result). */
  plannedEffects?(result: unknown): PlannedEffect[];
  /**
   * Tools with side effects: right after a successful call, the plain-JSON data `applyUndo` needs to reverse it (e.g. a
   * path and its prior content), or undefined when this call cannot be undone. Declared together with `applyUndo`.
   */
  undo?(args: unknown, result: unknown, context: ToolContext): Promise<UndoDescriptor | undefined>;
  /** Reverses one recorded call from its descriptor (`agent.undo`). */
  applyUndo?(descriptor: UndoDescriptor, context: UndoContext): Promise<UndoOutcome>;
  /** Effects recorded inside a result (the calls inside an `aigent_multi` result). */
  capturedEffects?(result: unknown): CapturedEffect[];
  /** The tool starts sub-runs of other agents (`delegate`): its context then carries `delegation`. */
  startsSubRuns?: boolean;
}
