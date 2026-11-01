import type { ArgTemplate } from './skill-types.js';

/** A step's arguments with every template filled in, or why one could not be. */
export type BoundArgs = { ok: true; args: Record<string, unknown> } | { ok: false; reason: string };

export interface BindStepArgsParams {
  args: Record<string, ArgTemplate>;
  /** The skill call's parameter values (already validated by the skill's schema). */
  params: Record<string, unknown>;
  /** An earlier step's result value at a JSON pointer; undefined when that step failed or has no such value. */
  valueAt(fromStep: number, path: string): unknown;
}

/**
 * Fills one step's argument templates. Values are copied as data: a parameter whose text looks like a template, a
 * pointer or code stays exactly that text, and the step's own tool schema validates the result.
 */
export function bindStepArgs(params: BindStepArgsParams): BoundArgs {
  const { args, params: values, valueAt } = params;
  const bound: Record<string, unknown> = {};
  for (const [name, template] of Object.entries(args)) {
    if ('const' in template) { bound[name] = structuredClone(template.const); continue; }
    if ('param' in template) {
      if (!Object.prototype.hasOwnProperty.call(values, template.param)) return { ok: false, reason: `argument '${name}' needs parameter '${template.param}', which the skill does not take` };
      bound[name] = values[template.param];
      continue;
    }
    const value = valueAt(template.fromStep, template.path);
    if (value === undefined) return { ok: false, reason: `argument '${name}' needs the value at '${template.path}' of step ${template.fromStep + 1}'s result, which it does not have` };
    bound[name] = structuredClone(value);
  }
  return { ok: true, args: bound };
}
