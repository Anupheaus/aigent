import type { z } from 'zod';
import type { ApprovalRisk, RequiresApproval } from '../approvals/approval-types.js';
import type { DryRunOutput } from '../effects/planned-effects.js';
import type { UndoContext, UndoDescriptor, UndoOutcome } from '../effects/undo-types.js';
import type { ContentKind, Fidelity } from '../shapers/shaper-types.js';
import type { DescribeActivity, ToolContext, ToolResumePolicy, ToolVerifyResult } from './tool-types.js';

export interface ToolBaseInput {
  name: string;
  description: string;
  /** Required: same name + args always give the same result. */
  deterministic: boolean;
  /** Required: whether results may be cached. */
  cache: boolean;
  /** Required when `cache` is true and `deterministic` is false. */
  cacheTtlMs?: number;
  /** Contract version label; bump it to invalidate cached results. */
  version?: string;
  /**
   * Deterministic cached tools only: entries are shared with every tool using the same namespace (and name, version,
   * schema and description), in any agent or runtime on the same store. Default: the requesting agent's own namespace.
   */
  cacheNamespace?: string;
  /** Deterministic cached tools only: true shares entries with every agent in the `global` namespace. Default false. */
  sharedCache?: boolean;
  /** What the result contains (`file-content`, `web-page`, `command-output`...). */
  contentKind?: ContentKind;
  /** Default `verbatim`. `lossy-ok` (which needs `contentKind`) lets shapers for that kind shorten what the model sees. */
  fidelity?: Fidelity;
  hasSideEffects?: boolean;
  /**
   * Default false. True lets the model write an alias from a shaped result (`F1`) as a whole string argument, expanded
   * to its text before validation. Only for arguments that are references (paths, ids), never literal values.
   */
  acceptsAliases?: boolean;
  timeoutMs?: number;
  maxResultTokens?: number;
  /** Default true. False keeps this tool's results out of compaction (never stubbed or summarised). */
  compactable?: boolean;
  /**
   * Default false. True lets a configured compressor shorten this tool's prose results when they are committed to
   * history; `'allow-code'` also allows results that look like code, diffs or JSON.
   */
  compressible?: boolean | 'allow-code';
  /**
   * Default true: the argument schema must fit the strict subset (every object `.strict()`, optionals sent as null) and
   * providers send the tool with strict decoding. `false` is an explicit opt-out for tools whose arguments a strict schema
   * cannot describe; the built-in `aigent_multi` is the only library tool that uses it. Arguments are still validated by zod.
   */
  strictSchema?: boolean;
  /** After a crash: `rerun`, `verify`, `ask` or `skip` a call that had started (default `rerun`, or `ask` with side effects). */
  resume?: ToolResumePolicy;
  /** A person must approve each call first (see `agent.approve`): always, by a predicate, or a policy with its reason. */
  requiresApproval?: RequiresApproval;
  /** Shown with approval requests. */
  risk?: ApprovalRisk;
  /** Text added once to the system prompt of agents with this tool (identical addenda appear once). */
  promptAddendum?: string;
}

export interface ToolInput<TSchema extends z.ZodType> extends ToolBaseInput {
  args: TSchema;
  /** Cached tools only: normalises the arguments into the cache key (default: the arguments). */
  cacheKey?(args: z.infer<TSchema>): unknown;
  /** Cached tools only: a token that changes when the data behind a result changes (e.g. mtime + size). */
  validity?(args: z.infer<TSchema>, context: ToolContext): Promise<string>;
  describeActivity: DescribeActivity<z.infer<TSchema>>;
  run(args: z.infer<TSchema>, context: ToolContext): Promise<unknown>;
  /** Required with `resume: 'verify'`: whether an interrupted call's effect already happened. */
  verify?(args: z.infer<TSchema>, context: ToolContext): Promise<ToolVerifyResult>;
  /** Tools with side effects: what the call would do, without doing it (dry runs refuse mutating tools without it). */
  dryRun?(args: z.infer<TSchema>, context: ToolContext): Promise<DryRunOutput>;
  /** Tools with side effects: after a successful call, the plain-JSON data that reverses it (with `applyUndo`). */
  undo?(args: z.infer<TSchema>, result: unknown, context: ToolContext): Promise<UndoDescriptor | undefined>;
  /** Reverses one recorded call from its descriptor (`agent.undo`). */
  applyUndo?(descriptor: UndoDescriptor, context: UndoContext): Promise<UndoOutcome>;
}
