import { z } from 'zod';
import { describeIssues } from '../core/describe-issues.js';

/** One change a mutating call would make, as its tool's `dryRun` describes it. */
export interface PlannedEffect {
  tool: string;
  callId: string;
  /** What kind of change, e.g. `file.write`, `row.delete`. */
  kind: string;
  /** What it changes, e.g. a path or a table. */
  target: string;
  summary: string;
  /** The current state (bounded to `MAX_EFFECT_TEXT_CHARS`). */
  before?: string;
  /** The state after the change (bounded). */
  after?: string;
  /** Whether the tool could undo it. */
  reversible: boolean;
}

/** What a tool's `dryRun` describes; the run adds `tool` and `callId`. */
export type PlannedEffectInput = Omit<PlannedEffect, 'tool' | 'callId'>;

/** A `dryRun` result: the effects alone, or a simulated result for the model plus the effects. */
export type DryRunOutput = PlannedEffectInput[] | { result: unknown; effects: PlannedEffectInput[] };

/** Longest `before` / `after` text kept per effect. */
export const MAX_EFFECT_TEXT_CHARS = 2_000;
const TRUNCATED_MARK = '... [truncated]';

const effectSchema = z.object({
  kind: z.string().min(1), target: z.string(), summary: z.string(), before: z.string().optional(), after: z.string().optional(), reversible: z.boolean(),
}).strict();

const outputSchema = z.union([z.array(effectSchema), z.object({ result: z.unknown(), effects: z.array(effectSchema) }).strict()]);

function bounded(text: string | undefined): string | undefined {
  if (text == null || text.length <= MAX_EFFECT_TEXT_CHARS) return text;
  return text.slice(0, MAX_EFFECT_TEXT_CHARS - TRUNCATED_MARK.length) + TRUNCATED_MARK;
}

/** The simulated result the model sees for a dry-run call: clearly marked, with what would happen. */
export interface SimulatedResult {
  simulated: true;
  result?: unknown;
  effects: PlannedEffect[];
}

export type PlannedOutcome = { ok: true; simulated: SimulatedResult } | { ok: false; error: string };

/** Validates a `dryRun` output and stamps each effect with its tool and call (texts bounded). */
export function toSimulated(params: { output: unknown; tool: string; callId: string }): PlannedOutcome {
  const { output, tool, callId } = params;
  const parsed = outputSchema.safeParse(output);
  if (!parsed.success) return { ok: false, error: `dryRun of tool '${tool}' returned an invalid plan (expected effects, or { result, effects }): ${describeIssues(parsed.error)}` };
  const inputs = Array.isArray(parsed.data) ? parsed.data : parsed.data.effects;
  const effects = inputs.map(({ before, after, ...rest }): PlannedEffect => {
    const shortBefore = bounded(before);
    const shortAfter = bounded(after);
    return { tool, callId, ...rest, ...(shortBefore == null ? {} : { before: shortBefore }), ...(shortAfter == null ? {} : { after: shortAfter }) };
  });
  const result = Array.isArray(parsed.data) ? undefined : parsed.data.result;
  return { ok: true, simulated: { simulated: true, ...(result === undefined ? {} : { result }), effects } };
}

/** Effects as stored: with content capture off, the target, summary and texts (which are content) are left out. */
export function storedEffects(params: { effects: PlannedEffect[]; captureContent: boolean }): PlannedEffect[] {
  const { effects, captureContent } = params;
  return captureContent ? effects.map(effect => ({ ...effect })) : effects.map(({ tool, callId, kind, reversible }) => ({ tool, callId, kind, target: '', summary: '', reversible }));
}
