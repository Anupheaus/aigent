import { z } from 'zod';
import { createAigentError } from './aigent-error.js';
import { describeIssues } from './describe-issues.js';

/** Anthropic's minimum thinking budget; smaller budgets are rejected by the API. */
const MIN_THINKING_BUDGET_TOKENS = 1024;
const MAX_TEMPERATURE = 2;
/** The most stop sequences OpenAI accepts; Anthropic accepts more, so this is the portable limit. */
const MAX_STOP_SEQUENCES = 4;

const thinkingSchema = z.union([
  z.enum(['off', 'on']),
  z.object({ budgetTokens: z.number().int().min(MIN_THINKING_BUDGET_TOKENS) }).strict(),
]);

/**
 * Model settings, resolved field by field task > agent > runtime > provider. Providers map what they support and the
 * run warns about (and leaves out) the rest.
 */
export const modelSettingsSchema = z.object({
  /** Context window the agent should plan for, in tokens. Runtime-only: never sent to the provider. */
  contextSize: z.number().int().positive().optional(),
  /** Most tokens the model may generate per request. */
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(MAX_TEMPERATURE).optional(),
  topP: z.number().min(0).max(1).optional(),
  /** Extended thinking: `'on'` lets the provider pick a budget; `{ budgetTokens }` sets one (at least 1024). */
  thinking: thinkingSchema.optional(),
  /** Reasoning effort; providers without an effort control map it to a thinking budget. */
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  /** Whether `thinking-delta` events reach the consumer (default true). Runtime-only. */
  showThinking: z.boolean().optional(),
  /** Requests prompt caching where the provider supports it. */
  promptCaching: z.boolean().optional(),
  /** Up to 4 non-empty stop sequences. */
  stop: z.array(z.string().min(1)).max(MAX_STOP_SEQUENCES).optional(),
  /** Sampling seed for providers that support reproducible sampling. */
  seed: z.number().int().nonnegative().optional(),
  /**
   * Provider-specific body fields keyed by provider id (`{ anthropic: { metadata: ... } }`): each provider gets only
   * its own entry, so one vendor's fields never reach another vendor's fallback. Fields the adapter sets itself
   * (`model`, `stream`, `messages`, mapped settings...) are ignored with a warning. Stored in run records as given.
   */
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).strict();

export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export interface ParseModelSettingsParams {
  /** Who owns the settings, for the message, e.g. `Agent 'writer'`. */
  owner: string;
  settings: unknown;
}

/** Validates definition-time settings (agent, runtime, provider layers); throws `invalid_definition` naming each bad field. */
export function parseModelSettings(params: ParseModelSettingsParams): ModelSettings | undefined {
  const { owner, settings } = params;
  if (settings === undefined) return undefined;
  const result = modelSettingsSchema.safeParse(settings);
  if (result.success) return result.data;
  throw createAigentError({
    code: 'invalid_definition',
    message: `${owner} has invalid modelSettings: ${describeIssues(result.error)}`,
    details: { owner, issues: result.error.issues.length },
  });
}
