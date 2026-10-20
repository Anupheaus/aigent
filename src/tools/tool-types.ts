import type { z } from 'zod';
import type { JsonSchema } from '../providers/provider-types.js';

export interface ToolContext {
  agentName: string;
  instanceId: string;
  runId: string;
  /** Aborts when the run is stopped; long-running tools should honour it. */
  signal: AbortSignal;
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
  /** Strict JSON schema derived from `argsSchema`. */
  jsonSchema: JsonSchema;
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
}
