import { createAigentError } from '../../../core/aigent-error.js';
import { MAX_SEARCH_K } from '../../../knowledge/search-knowledge.js';
import type { Tool } from '../../tool-types.js';
import { createKnowledgeRead } from './knowledge-read.js';
import { createKnowledgeSearch } from './knowledge-search.js';
import type { KnowledgeToolsOptions } from './knowledge-shared.js';

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_RESULT_TOKENS = 6_000;

function invalid(message: string, option: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `knowledgeTools: ${message}`, details: { option } });
}

/**
 * The knowledge pack: `knowledge_search` and `knowledge_read` over `options.base`, with a system-prompt rule to cite
 * passages as `[[cite:<chunkId>]]` (resolved into `TaskResult.citations`). Without a base no tool is registered.
 */
export function knowledgeTools(options: KnowledgeToolsOptions): Tool[] {
  const { base, maxResults = DEFAULT_MAX_RESULTS, maxResultTokens = DEFAULT_MAX_RESULT_TOKENS } = options ?? {};
  if (base == null) return [];
  if (typeof base.search !== 'function' || typeof base.read !== 'function' || typeof base.version !== 'function') invalid('base must come from createKnowledgeBase', 'base');
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_K) invalid(`maxResults must be an integer from 1 to ${MAX_SEARCH_K}, got ${String(maxResults)}`, 'maxResults');
  if (!Number.isSafeInteger(maxResultTokens) || maxResultTokens <= 0) invalid(`maxResultTokens must be a positive integer, got ${String(maxResultTokens)}`, 'maxResultTokens');
  const deps = { base, maxResults, maxResultTokens };
  return [createKnowledgeSearch(deps), createKnowledgeRead(deps)];
}
