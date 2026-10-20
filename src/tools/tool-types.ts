import type { z } from 'zod';
import type { JsonSchema } from '../providers/provider-types.js';
import type { ExecutedToolCall } from './execute-tool-call.js';
import type { ToolErrorDetail } from './tool-error-detail.js';

export interface ToolContext {
  agentName: string;
  instanceId: string;
  runId: string;
  /** This call's id (the inner call's own id inside `aigent_multi`). */
  callId: string;
  /** Aborts when the run is stopped; long-running tools should honour it. */
  signal: AbortSignal;
}

/** One `aigent_multi` inner call, as the model wrote it. */
export interface InnerCall {
  id: string;
  tool: string;
  args: unknown;
}

/** Called once an inner call has finished (or was refused), with what it produced. */
export type FinishInnerCall = (executed: ExecutedToolCall) => void;

/** Run-internal context given only to `aigent_multi`, so its inner calls share the run's `maxToolCalls` budget. */
export interface MultiToolContext extends ToolContext {
  /** Takes one call from the run's budget; false once the budget is spent. */
  reserveToolCall(): boolean;
  /** Called as each inner call starts, in call order, so the run can trace it; returns its finisher. */
  traceInnerCall?(call: InnerCall): FinishInnerCall;
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
  hasSideEffects: boolean;
  timeoutMs: number;
  maxResultTokens?: number;
  describeActivity: DescribeActivity<unknown>;
  run(args: unknown, context: ToolContext): Promise<unknown>;
  /** Optional aggregate outcome for the activity renderer; default is success. */
  summarise?(result: unknown): ToolOutcome;
  /** Failures inside a successful aggregate result (batch items, `aigent_multi` calls), reported in `TaskResult.errors`. */
  nestedFailures?(result: unknown): ToolErrorDetail[];
  /** Item totals of a batch result, for tool telemetry (`defineBatchTool` sets it). */
  countItems?(result: unknown): ItemCounts;
}
