import type { Citation } from '../../../core/citations.js';
import type { KnowledgeBase } from '../../../knowledge/knowledge-types.js';

/** `knowledgeTools(options)`. */
export interface KnowledgeToolsOptions {
  /** The knowledge base to search; without one no tool is registered. */
  base?: KnowledgeBase;
  /** Most results one query may ask for (default 10, at most 20). */
  maxResults?: number;
  /** The result budget of one call (default 6_000 tokens), shared by its items. */
  maxResultTokens?: number;
}

/** What the knowledge tools are built from. */
export interface KnowledgeDeps {
  base: KnowledgeBase;
  maxResults: number;
  maxResultTokens: number;
}

/** Added once to the system prompt of agents with the knowledge tools. */
export const CITATION_ADDENDUM = 'Knowledge tools: when your answer uses text that knowledge_search or knowledge_read returned, cite each passage right after the statement it supports by writing [[cite:<chunkId>]] with the chunkId those tools gave. Cite only chunk ids they returned; the markers are removed from the answer and turned into structured citations.';

/** The citations in a batch result of the knowledge tools (search hits' and read chunks' `citation` fields). */
export function citationsOf(result: unknown): Citation[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap(entry => {
    const { ok, result: item } = (entry ?? {}) as { ok?: boolean; result?: { results?: { citation?: Citation }[]; citation?: Citation } };
    if (ok !== true || item == null) return [];
    const found = [...(item.results ?? []).map(({ citation }) => citation), item.citation];
    return found.filter((citation): citation is Citation => typeof citation?.chunkId === 'string');
  });
}
