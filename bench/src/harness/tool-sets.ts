import { fsTools } from '../../../src/tools/packs/fs/index.js';
import { indexTools } from '../../../src/tools/packs/index/index.js';
import { benchError } from '../bench-error.js';
import { BENCH_SEARCH_BUDGET_MS, benchFsOptions, round0Tools } from './repo-tools.js';
import type { ToolSetBuilder } from './repo-tools.js';

/** A builder offering the named filesystem tools plus the repository index tools. */
const withIndex = (fsNames: string[]): ToolSetBuilder => ({ access, policy }) => [
  ...fsTools(benchFsOptions({ access, policy })).filter(({ name }) => fsNames.includes(name)),
  ...indexTools({ policy, access, searchBudgetMs: BENCH_SEARCH_BUDGET_MS }),
];

/**
 * Tool sets by CLI name: `round0` is the plain filesystem set (as improved in Round 1); `index` adds the repository
 * index (Round 2; listing dropped, the map replaces it); `optimised` keeps only `fs_read` beside the index (Round 3:
 * `search_layers` replaces `fs_search`, and every schema sent with each request costs tokens).
 */
export const TOOL_SETS: Record<string, ToolSetBuilder> = { round0: round0Tools, index: withIndex(['fs_read', 'fs_search']), optimised: withIndex(['fs_read']) };

export function toolSet(name: string): ToolSetBuilder {
  const builder = TOOL_SETS[name];
  if (builder == null) throw benchError(`unknown tool set '${name}'; expected one of ${Object.keys(TOOL_SETS).join(', ')}`, { name });
  return builder;
}
