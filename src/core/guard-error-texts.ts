import type { ToolErrorDetail } from '../tools/tool-error-detail.js';

/** The parts of a failure that may carry text from outside: what the toolResult checks see of a failed call. */
export interface ErrorTexts {
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export function errorTextsOf(error: ToolErrorDetail): ErrorTexts {
  const { message, suggestion, details } = error;
  return { message, ...(suggestion == null ? {} : { suggestion }), ...(details == null ? {} : { details }) };
}

/** The failure with its guarded texts; a check that turned them into one text (a quarantine) makes that the message. */
export function withErrorTexts(params: { error: ToolErrorDetail; guarded: unknown }): ToolErrorDetail {
  const { error, guarded } = params;
  const { suggestion: _suggestion, details: _details, ...kept } = error;
  if (typeof guarded !== 'object' || guarded === null || typeof (guarded as ErrorTexts).message !== 'string') return { ...kept, message: typeof guarded === 'string' ? guarded : JSON.stringify(guarded) };
  return { ...kept, ...(guarded as ErrorTexts) };
}
