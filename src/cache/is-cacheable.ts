import type { Tool } from '../tools/tool-types.js';

/** Cached only when flagged, free of side effects and either deterministic or bounded by a TTL. */
export function isCacheable(tool: Tool): boolean {
  const { cache, hasSideEffects, deterministic, cacheTtlMs } = tool;
  return cache && !hasSideEffects && (deterministic || (cacheTtlMs ?? 0) > 0);
}
