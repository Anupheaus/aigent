import type { z } from 'zod';
import type { JsonSchema } from '../providers/provider-types.js';
import type { ToolErrorDetail } from './tool-error-detail.js';

export interface ToolContext {
  agentName: string;
  instanceId: string;
  runId: string;
  /** Aborts when the run is stopped; long-running tools should honour it. */
  signal: AbortSignal;
}

/** Run-internal context given only to `aigent_multi`, so its inner calls share the run's `maxToolCalls` budget. */
export interface MultiToolContext extends ToolContext {
  /** Takes one call from the run's budget; false once the budget is spent. */
  reserveToolCall(): boolean;
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
}
