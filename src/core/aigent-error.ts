/** Machine-readable reason an aigent operation failed. */
export type AigentErrorCode =
  | 'invalid_definition'
  | 'invalid_input'
  | 'unknown_provider'
  | 'provider_failed'
  | 'aborted'
  | 'store_conflict'
  /** The prompt cannot fit the context window even after compaction (details carry the sizes). */
  | 'context_overflow';

export interface AigentError extends Error {
  code: AigentErrorCode;
  details?: Record<string, unknown>;
}

export interface AigentErrorInit {
  code: AigentErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

const ERROR_NAME = 'AigentError';

export function createAigentError(init: AigentErrorInit): AigentError {
  const { code, message, details } = init;
  const error = new Error(message) as AigentError;
  error.name = ERROR_NAME;
  error.code = code;
  if (details != null) error.details = details;
  return error;
}

export function isAigentError(value: unknown): value is AigentError {
  return value instanceof Error && value.name === ERROR_NAME;
}
