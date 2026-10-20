import { isAigentError } from '../../../core/aigent-error.js';
import { toolFailure } from '../../tool-failure.js';
import type { ToolFailure } from '../../tool-failure.js';

/** Upper bound on items in one data call. */
export const MAX_DATA_ITEMS = 50;

/** The shared tool fields of the data pack: pure functions of their arguments, so results are cached for everyone. */
export const DATA_TOOL_BASE = { deterministic: true, cache: true, sharedCache: true, maxItems: MAX_DATA_ITEMS } as const;

/** A pure helper's `invalid_input` (with `details.reason`) as the model sees it: the reason is the item's code. */
export function asItemFailure(error: unknown): unknown {
  if (!isAigentError(error) || error.code !== 'invalid_input') return error;
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : 'invalid_input';
  return toolFailure({ code: reason, message: error.message, ...(error.details == null ? {} : { details: error.details }) }) satisfies ToolFailure;
}

/** Runs a pure helper, turning its structured errors into item failures. */
export function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw asItemFailure(error);
  }
}
