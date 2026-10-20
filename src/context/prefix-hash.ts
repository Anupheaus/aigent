import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';
import type { ProviderMessage, ProviderToolSpec } from '../providers/provider-types.js';

const HASH_ALGORITHM = 'sha256';

/**
 * Lowercase hex sha-256 over the canonical JSON of everything that precedes the volatile block: the stored messages
 * (system prompt first) and the tool specs sorted by name. Equal hashes mean a provider can reuse its prompt cache.
 */
export function computePrefixHash(messages: ProviderMessage[], tools: ProviderToolSpec[]): string {
  const sortedTools = [...tools].sort((left, right) => left.name.localeCompare(right.name));
  return createHash(HASH_ALGORITHM).update(canonicalJson({ tools: sortedTools, messages })).digest('hex');
}
