import type { ToolCall } from '../providers/provider-types.js';
import { MULTI_TOOL_NAME } from './multi-tool.js';

/**
 * Wrapper fields the runtime adds to tools' JSON schemas (feedback's `previous`, memory's `memory`). The loop takes
 * them out before a tool's arguments are validated, run, cached or recorded; every path that hands a model-sent call
 * to a tool (a live dispatch, a resumed run's interrupted round) strips them with these helpers.
 */
export interface SplitInjectedFieldResult {
  /** The arguments without the field. */
  args: unknown;
  /** The field as the model sent it (`undefined` when absent or the arguments are not an object). */
  value: unknown;
}

export interface StripInnerFieldResult {
  /** The `aigent_multi` arguments with the field taken out of every inner call's arguments. */
  args: unknown;
  /** Ids of the inner calls that carried the field (null included), in call order. */
  strippedCallIds: string[];
}

/** A call's arguments and the injected field to take out of them. */
export interface InjectedFieldParams {
  args: unknown;
  field: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Takes `field` out of a call's arguments, never mutating them. */
export function splitInjectedField(params: InjectedFieldParams): SplitInjectedFieldResult {
  const { args: rawArgs, field } = params;
  if (!isPlainObject(rawArgs)) return { args: rawArgs, value: undefined };
  const { [field]: value, ...args } = rawArgs;
  return { args, value };
}

/**
 * Takes `field` out of every `aigent_multi` inner call's arguments (never mutating them). Only the wrapper carries
 * injected fields; a model may add them to inner calls anyway, and the inner tools' strict schemas would reject them.
 */
export function stripInnerField(params: InjectedFieldParams): StripInnerFieldResult {
  const { args: multiArgs, field } = params;
  if (!isPlainObject(multiArgs) || !Array.isArray(multiArgs.calls)) return { args: multiArgs, strippedCallIds: [] };
  const strippedCallIds: string[] = [];
  const calls = multiArgs.calls.map((innerCall: unknown) => {
    if (!isPlainObject(innerCall) || !isPlainObject(innerCall.args) || !(field in innerCall.args)) return innerCall;
    const { [field]: _ignored, ...innerArgs } = innerCall.args;
    strippedCallIds.push(String(innerCall.id));
    return { ...innerCall, args: innerArgs };
  });
  return { args: { ...multiArgs, calls }, strippedCallIds };
}

/** A call and the injected fields to take out of it. */
export interface StripInjectedFieldsParams {
  call: ToolCall;
  fields: readonly string[];
}

/** The call with each of `fields` taken out of its arguments, and out of its inner calls when it is `aigent_multi`. */
export function stripInjectedFields(params: StripInjectedFieldsParams): ToolCall {
  const { call, fields } = params;
  const args = fields.reduce((current: unknown, field) => {
    const { args: topLevel } = splitInjectedField({ args: current, field });
    return call.name === MULTI_TOOL_NAME ? stripInnerField({ args: topLevel, field }).args : topLevel;
  }, call.args);
  return fields.length === 0 ? call : { ...call, args };
}
