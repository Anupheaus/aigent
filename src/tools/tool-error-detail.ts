import { describeValue } from '../core/describe-value.js';
import { isToolFailure } from './tool-failure.js';
import type { FieldError } from './parse-tool-args.js';

export type ToolErrorCategory = 'validation' | 'unknown_tool' | 'thrown' | 'timeout' | 'aborted' | 'denied';

/** Complete, machine-readable description of a tool failure. */
export interface ToolErrorDetail {
  category: ToolErrorCategory;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  fieldErrors?: FieldError[];
  retryable: boolean;
  suggestion?: string;
}

/** Copy of `detail` with `extra` merged into its details, e.g. to say which inner call or batch item failed. */
export function addErrorDetails(detail: ToolErrorDetail, extra: Record<string, unknown>): ToolErrorDetail {
  return { ...detail, details: { ...detail.details, ...extra } };
}

/** Converts anything thrown (including non-Error values) into a structured failure. */
export function describeThrown(error: unknown): ToolErrorDetail {
  if (isToolFailure(error)) {
    const { code, message, details, retryable = false, suggestion } = error.init;
    return { category: 'thrown', code, message, details, retryable, suggestion };
  }
  if (error instanceof Error) return { category: 'thrown', code: 'tool_threw', message: error.message, retryable: false };
  return { category: 'thrown', code: 'tool_threw', message: `Tool threw a non-Error value: ${describeValue(error)}`, retryable: false };
}
