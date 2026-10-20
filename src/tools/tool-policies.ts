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

/** The approval fields of a tool definition, checked without their argument types. */
export interface ApprovalFieldsInput {
  name: string;
  requiresApproval?: unknown;
  risk?: unknown;
}

const RISKS: readonly unknown[] = ['low', 'medium', 'high'];

/** Throws `invalid_definition` for a `requiresApproval` that is not a boolean, function or policy object, or an unknown `risk`. */
export function validateApprovalFields(input: ApprovalFieldsInput): void {
  const { name, requiresApproval, risk } = input;
  const isPolicy = typeof requiresApproval === 'object' && requiresApproval !== null && !Array.isArray(requiresApproval);
  if (requiresApproval !== undefined && typeof requiresApproval !== 'boolean' && typeof requiresApproval !== 'function' && !isPolicy) invalid({ name, message: 'requiresApproval must be a boolean, a function of the arguments, or { when?, reason? }' });
  if (isPolicy) {
    const { when, reason } = requiresApproval as { when?: unknown; reason?: unknown };
    if (when !== undefined && typeof when !== 'function') invalid({ name, message: 'requiresApproval.when must be a function of the arguments' });
    if (reason !== undefined && typeof reason !== 'string') invalid({ name, message: 'requiresApproval.reason must be a string' });
  }
  if (risk !== undefined && !RISKS.includes(risk)) invalid({ name, message: `risk must be low, medium or high, got ${String(risk)}` });
}

/** The tool's declared policy, else `rerun` for read-only tools and `ask` for tools with side effects. */
export function resumePolicyOf(tool: Pick<Tool, 'resume' | 'hasSideEffects'>): ToolResumePolicy {
  return tool.resume ?? (tool.hasSideEffects ? 'ask' : 'rerun');
}
