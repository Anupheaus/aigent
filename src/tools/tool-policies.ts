import { createAigentError } from '../core/aigent-error.js';
import type { Tool, ToolResumePolicy } from './tool-types.js';

/** Every way a resumed run may treat a call that had started but not finished. */
export const TOOL_RESUME_POLICIES: readonly ToolResumePolicy[] = ['rerun', 'verify', 'ask', 'skip'];

/** The resume and verify fields of a tool definition, checked without their argument types. */
export interface ResumeFieldsInput {
  name: string;
  resume?: unknown;
  verify?: unknown;
}

function invalid(params: { name: string; message: string }): never {
  const { name, message } = params;
  throw createAigentError({ code: 'invalid_definition', message: `Tool '${name}': ${message}`, details: { tool: name } });
}

/** Throws `invalid_definition` for an unknown `resume`, a non-function `verify`, or `resume: 'verify'` without `verify`. */
export function validateResumeFields(input: ResumeFieldsInput): void {
  const { name, resume, verify } = input;
  if (resume !== undefined && !(TOOL_RESUME_POLICIES as readonly unknown[]).includes(resume)) invalid({ name, message: `resume must be one of ${TOOL_RESUME_POLICIES.join(', ')}, got ${String(resume)}` });
  if (verify !== undefined && typeof verify !== 'function') invalid({ name, message: 'verify must be a function of the arguments and context' });
  if (resume === 'verify' && verify === undefined) invalid({ name, message: "resume 'verify' needs a verify function that says whether the call's effect already happened" });
}

/** The tool's declared policy, else `rerun` for read-only tools and `ask` for tools with side effects. */
export function resumePolicyOf(tool: Pick<Tool, 'resume' | 'hasSideEffects'>): ToolResumePolicy {
  return tool.resume ?? (tool.hasSideEffects ? 'ask' : 'rerun');
}
