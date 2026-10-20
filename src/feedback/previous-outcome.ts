import { describeIssues } from '../core/describe-issues.js';
import { DIRECTIVE_SCHEMAS } from '../streaming/directive-schemas.js';

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Takes `previous` out of a call's arguments (never mutating them) and validates it with the outcome directive's schema. */
export function splitPrevious(rawArgs: unknown): SplitPreviousResult {
  if (!isPlainObject(rawArgs)) return { args: rawArgs, previous: { kind: 'missing' } };
  const { [PREVIOUS_FIELD]: previous, ...args } = rawArgs;
  if (previous == null) return { args, previous: { kind: 'missing' } };
  const parsed = DIRECTIVE_SCHEMAS.outcome.safeParse(previous);
  if (!parsed.success) return { args, previous: { kind: 'invalid', reason: describeIssues(parsed.error) } };
  return { args, previous: { kind: 'reported', outcome: parsed.data } };
}

export interface StripInnerPreviousResult {
  /** The `aigent_multi` arguments with `previous` taken out of every inner call's arguments. */
  args: unknown;
  /** Ids of the inner calls that carried `previous` (null included), in call order. */
  strippedCallIds: string[];
}

/**
 * Inner `aigent_multi` calls never carry `previous` (the wrapper reports for them), but a model may add it anyway.
 * Their tools' strict schemas would reject the unknown key, so it is taken out (never mutating the input) and ignored.
 */
export function stripInnerPrevious(multiArgs: unknown): StripInnerPreviousResult {
  if (!isPlainObject(multiArgs) || !Array.isArray(multiArgs.calls)) return { args: multiArgs, strippedCallIds: [] };
  const strippedCallIds: string[] = [];
  const calls = multiArgs.calls.map((innerCall: unknown) => {
    if (!isPlainObject(innerCall) || !isPlainObject(innerCall.args) || !(PREVIOUS_FIELD in innerCall.args)) return innerCall;
    const { [PREVIOUS_FIELD]: _ignored, ...innerArgs } = innerCall.args;
    strippedCallIds.push(String(innerCall.id));
    return { ...innerCall, args: innerArgs };
  });
  return { args: { ...multiArgs, calls }, strippedCallIds };
}
