import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';
import type { UndoDescriptor } from './undo-types.js';

/** sha-256 of the descriptor's canonical JSON: shows whether stored undo data is still what the tool captured. */
export function hashDescriptor(descriptor: UndoDescriptor): string {
  return createHash('sha256').update(canonicalJson(descriptor)).digest('hex');
}
