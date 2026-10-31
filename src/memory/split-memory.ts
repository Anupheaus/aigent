import { MEMORY_FIELD } from './memory-schema.js';

export interface SplitMemoryResult {
  /** The arguments without `memory`: what the tool is validated, run, cached and recorded with. */
  args: unknown;
  /** The field as the model sent it. */
  value: unknown;
  /** The field holds something other than null. */
  isPresent: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Takes `memory` out of a call's arguments, never mutating them. */
export function splitMemory(rawArgs: unknown): SplitMemoryResult {
  if (!isPlainObject(rawArgs)) return { args: rawArgs, value: undefined, isPresent: false };
  const { [MEMORY_FIELD]: value, ...args } = rawArgs;
  return { args, value, isPresent: value != null };
}

export interface StripInnerMemoryResult {
  /** The `aigent_multi` arguments with `memory` taken out of every inner call's arguments. */
  args: unknown;
  /** Ids of the inner calls that carried `memory` (null included), in call order. */
  strippedCallIds: string[];
}

/**
 * Only the top level of `aigent_multi` carries `memory`. A model may add it to inner calls anyway; their tools' strict
 * schemas would reject the unknown key, so it is taken out (never mutating the input) and not saved.
 */
export function stripInnerMemory(multiArgs: unknown): StripInnerMemoryResult {
  if (!isPlainObject(multiArgs) || !Array.isArray(multiArgs.calls)) return { args: multiArgs, strippedCallIds: [] };
  const strippedCallIds: string[] = [];
  const calls = multiArgs.calls.map((innerCall: unknown) => {
    if (!isPlainObject(innerCall) || !isPlainObject(innerCall.args) || !(MEMORY_FIELD in innerCall.args)) return innerCall;
    const { [MEMORY_FIELD]: _ignored, ...innerArgs } = innerCall.args;
    strippedCallIds.push(String(innerCall.id));
    return { ...innerCall, args: innerArgs };
  });
  return { args: { ...multiArgs, calls }, strippedCallIds };
}
