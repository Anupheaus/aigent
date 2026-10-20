import { createAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';

/** What a closed chat answers to anything that would change it. */
export function closedError(sessionId: string): AigentError {
  return createAigentError({ code: 'invalid_input', message: `Chat session '${sessionId}' is closed; open it again with agent.chat({ sessionId }) to continue`, details: { sessionId } });
}
