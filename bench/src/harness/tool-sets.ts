import { benchError } from '../bench-error.js';
import { round0Tools } from './repo-tools.js';
import type { ToolSetBuilder } from './repo-tools.js';

/** Tool sets a run can offer, by CLI name. */
export const TOOL_SETS: Record<string, ToolSetBuilder> = { round0: round0Tools };

export function toolSet(name: string): ToolSetBuilder {
  const builder = TOOL_SETS[name];
  if (builder == null) throw benchError(`unknown tool set '${name}'; expected one of ${Object.keys(TOOL_SETS).join(', ')}`, { name });
  return builder;
}
