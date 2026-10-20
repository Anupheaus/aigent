import type { z } from 'zod';

/** Where a guardrail runs, in the order a run meets them. */
export const GUARDRAIL_STAGES = ['input', 'toolCall', 'toolResult', 'output', 'stream'] as const;

export type GuardrailStage = typeof GUARDRAIL_STAGES[number];

/** The built-in guardrails, in the fixed order they run (before any custom guardrail). */
export const BUILTIN_GUARDRAILS = ['secrets', 'pii', 'injection', 'scope', 'loop-guard', 'output-schema'] as const;

export type BuiltinGuardrailName = typeof BUILTIN_GUARDRAILS[number];

/** A planned tool call (`toolCall` stage). */
export interface ToolCallValue {
  tool: string;
  args: unknown;
}

/** A tool's result before the model sees it (`toolResult` stage). */
export interface ToolResultValue {
  tool: string;
  result: unknown;
}

/** Text for `input`, `output` and `stream`; a call or a result for the tool stages. */
export type GuardrailValue = string | ToolCallValue | ToolResultValue;

/** What a guardrail knows about where it runs. */
export interface GuardrailContext {
  stage: GuardrailStage;
  runId: string;
  agentName: string;
  /** The tool call, for the tool stages. */
  callId?: string;
  /** Records a non-blocking finding (it becomes a `guardrail` event with action `warn`, and a `warning`). */
  warn(message: string): void;
}

/** A guardrail's verdict: let the value through, replace it (saying why), or stop it. */
export type GuardrailDecision =
  | { action: 'allow' }
  | { action: 'rewrite'; value: unknown; note: string }
  | { action: 'block'; reason: string; code: string };

/** A pure async check run at one stage. */
export interface Guardrail {
  /** Lowercase kebab or snake case, e.g. `no-prices`. */
  name: string;
  stage: GuardrailStage;
  /** A failing check (throw or timeout) blocks even with `failMode: 'open'`. */
  blockLevel?: boolean;
  /** Custom guardrails run in ascending `order` (default 0), then registration order; built-ins always run first. */
  order?: number;
  check(value: GuardrailValue, context: GuardrailContext): Promise<GuardrailDecision> | GuardrailDecision;
}

/** What a recorded decision did. `error`: the check threw or timed out (the record says whether that blocked). */
export type GuardrailAction = 'rewrite' | 'block' | 'warn' | 'error';

/** Every non-allow decision of a run, as stored on its run record and its steps and given in `guardrail` events. */
export interface GuardrailDecisionRecord {
  guardrail: string;
  stage: GuardrailStage;
  action: GuardrailAction;
  /** Block code (`guardrail_blocked` reasons such as `secret`, `repeated_call`, `output_invalid`). */
  code?: string;
  /** The reason, note or warning. */
  message: string;
  callId?: string;
  /** For `error`: whether it blocked (fail closed). */
  isBlocking?: boolean;
}

/** PII handling per stage: warn about it, redact it, or ignore it. */
export type PiiMode = 'warn' | 'redact' | 'off';

export interface PiiOptions {
  /** Default `warn`. */
  output?: PiiMode;
  /** Default `off`. */
  toolResult?: PiiMode;
}

export interface ScopeOptions {
  /** Only these tools may be called (when set). */
  allowTools?: string[];
  /** These tools are never called. Task `outOfScope` entries that name a tool are added. */
  denyTools?: string[];
  /** Output containing one of these (case-insensitive) gets a warning. */
  forbiddenTerms?: string[];
}

export interface LoopGuardOptions {
  /** Identical calls (same tool and arguments) allowed per run before the next is blocked; default 3 (the 4th is blocked). */
  maxRepeats?: number;
  /** Longest final answer; a longer one is truncated with a note. Default 200_000. */
  maxOutputChars?: number;
}

export interface OutputSchemaOptions {
  /** Extra turns the model gets to fix an answer that fails the task's `output` schema; default 2. */
  retries?: number;
}

export interface SecretsOptions {
  /** Characters of streamed text held back so a secret split across chunks is redacted before display; default 64. */
  holdBackChars?: number;
}

/** Options per built-in (`false` turns one off). */
export interface BuiltinGuardrailOptions {
  secrets?: SecretsOptions;
  pii?: PiiOptions;
  injection?: Record<string, never>;
  scope?: ScopeOptions;
  'loop-guard'?: LoopGuardOptions;
  'output-schema'?: OutputSchemaOptions;
}

/** `createAigent({ guardrails })`. */
export interface GuardrailOptions {
  builtins?: { [Name in BuiltinGuardrailName]?: false | NonNullable<BuiltinGuardrailOptions[Name]> };
  custom?: Guardrail[];
  /** What a throwing or timed-out check means: `closed` (default) blocks, `open` allows with a warning (unless `blockLevel`). */
  failMode?: 'closed' | 'open';
  /** Longest a check may take; default 2000 ms. */
  timeoutMs?: number;
}

/** What the built-ins need from the run they guard. */
export interface GuardrailRunContext {
  /** The task's `outOfScope` entries. */
  outOfScope?: string[];
  /** The task's structured output schema. */
  output?: z.ZodType;
  /** How the answer carries the output: JSON text (default) or the text itself. */
  outputFormat?: 'json' | 'text';
}
