import { createAigentError } from '../../src/index.js';
import type { AigentError } from '../../src/index.js';

/** The bench's errors are the library's errors (`invalid_input`), with the values involved in `details`. */
export function benchError(message: string, details: Record<string, unknown> = {}): AigentError {
  return createAigentError({ code: 'invalid_input', message, details });
}
