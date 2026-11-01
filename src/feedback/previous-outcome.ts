import { describeIssues } from '../core/describe-issues.js';
import { DIRECTIVE_SCHEMAS } from '../streaming/directive-schemas.js';
import { splitInjectedField, stripInnerField } from '../tools/injected-fields.js';
import type { StripInnerFieldResult } from '../tools/injected-fields.js';

/** The argument key that carries the agent's verdict on its previous tool step. */
export const PREVIOUS_FIELD = 'previous';

/** The agent's verdict on a step, as reported (by `previous` or an `outcome` directive). */
export interface ReportedOutcome {
  success: boolean;
  answer: string;
}

export type PreviousReport =
  | { kind: 'reported'; outcome: ReportedOutcome }
  /** Absent or null: allowed on the first call, a soft omission after it. */
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string };

export interface SplitPreviousResult {
  /** The arguments without `previous`: what the tool is validated, run, cached and recorded with. */
  args: unknown;
  previous: PreviousReport;
}

/** Takes `previous` out of a call's arguments (never mutating them) and validates it with the outcome directive's schema. */
export function splitPrevious(rawArgs: unknown): SplitPreviousResult {
  const { args, value: previous } = splitInjectedField({ args: rawArgs, field: PREVIOUS_FIELD });
  if (previous == null) return { args, previous: { kind: 'missing' } };
  const parsed = DIRECTIVE_SCHEMAS.outcome.safeParse(previous);
  if (!parsed.success) return { args, previous: { kind: 'invalid', reason: describeIssues(parsed.error) } };
  return { args, previous: { kind: 'reported', outcome: parsed.data } };
}

/** The `aigent_multi` arguments with `previous` taken out of every inner call, and the ids of the calls that carried it. */
export type StripInnerPreviousResult = StripInnerFieldResult;

/**
 * Inner `aigent_multi` calls never carry `previous` (the wrapper reports for them), but a model may add it anyway.
 * Their tools' strict schemas would reject the unknown key, so it is taken out (never mutating the input) and ignored.
 */
export function stripInnerPrevious(multiArgs: unknown): StripInnerPreviousResult {
  return stripInnerField({ args: multiArgs, field: PREVIOUS_FIELD });
}
