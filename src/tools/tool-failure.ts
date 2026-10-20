import type { ToolErrorCategory } from './tool-error-detail.js';

export interface ToolFailureInit {
  code: string;
  /** Default `thrown`. `denied` for refusals by a policy (outside the allowed roots, protected files...). */
  category?: ToolErrorCategory;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
  suggestion?: string;
}

export interface ToolFailure extends Error {
  isToolFailure: true;
  init: ToolFailureInit;
}

/** Create inside a tool to report a structured, model-readable failure (throw it). */
export function toolFailure(init: ToolFailureInit): ToolFailure {
  const failure = new Error(init.message) as ToolFailure;
  failure.name = 'ToolFailure';
  failure.isToolFailure = true;
  failure.init = init;
  return failure;
}

export function isToolFailure(value: unknown): value is ToolFailure {
  return value instanceof Error && (value as ToolFailure).isToolFailure === true;
}
