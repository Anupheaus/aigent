import { splitInjectedField, stripInnerField } from '../tools/injected-fields.js';
import type { StripInnerFieldResult } from '../tools/injected-fields.js';
import { MEMORY_FIELD } from './memory-schema.js';

export interface SplitMemoryResult {
  /** The arguments without `memory`: what the tool is validated, run, cached and recorded with. */
  args: unknown;
  /** The field as the model sent it. */
  value: unknown;
  /** The field holds something other than null. */
  isPresent: boolean;
}

/** Takes `memory` out of a call's arguments, never mutating them. */
export function splitMemory(rawArgs: unknown): SplitMemoryResult {
  const { args, value } = splitInjectedField({ args: rawArgs, field: MEMORY_FIELD });
  return { args, value, isPresent: value != null };
}

/** The `aigent_multi` arguments with `memory` taken out of every inner call, and the ids of the calls that carried it. */
export type StripInnerMemoryResult = StripInnerFieldResult;

/**
 * Only the top level of `aigent_multi` carries `memory`. A model may add it to inner calls anyway; their tools' strict
 * schemas would reject the unknown key, so it is taken out (never mutating the input) and not saved.
 */
export function stripInnerMemory(multiArgs: unknown): StripInnerMemoryResult {
  return stripInnerField({ args: multiArgs, field: MEMORY_FIELD });
}
