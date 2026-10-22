import { z } from 'zod';
import { BATCH_RESULT_HELPERS_WITH_REASONS } from '../../batch-entries.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { CODE_CACHE_TTL_MS, CODE_TOOL_TIMEOUT_MS, MAX_CODE_ITEMS } from './code-shared.js';
import type { CodeDeps } from './code-shared.js';
import { codeValidity } from './code-validity.js';
import { collectDefinitions, searchRoots } from './symbol-index.js';
import type { Definition } from './symbol-index.js';

export const CODE_FIND_SYMBOL_TOOL_NAME = 'code_find_symbol';
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 100;
const FIND_MAX_RESULT_TOKENS = 6_000;

const findItem = z.object({
  name: z.string().min(1).describe('The symbol name, e.g. createUser or UserService (exact; other cases rank lower)'),
  kind: z.enum(['function', 'class', 'interface', 'type', 'enum', 'namespace', 'method', 'property', 'constructor', 'getter', 'setter', 'enum-member', 'const', 'variable']).optional(),
  scope: z.string().min(1).optional().describe('Only definitions under this path prefix (absolute, or relative to the workspace root)'),
  exportedOnly: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`Default ${DEFAULT_MAX_RESULTS}`),
}).strict();

/** Exact names first, then exported ones, then shallow paths, then path and line. */
function rank(params: { name: string; definitions: Definition[] }): Definition[] {
  const { name, definitions } = params;
  const depth = (path: string): number => path.split(/[\\/]/).length;
  return [...definitions].sort((left, right) => Number(right.name === name) - Number(left.name === name)
    || Number(right.exported) - Number(left.exported) || depth(left.path) - depth(right.path) || left.path.localeCompare(right.path) || left.line - right.line);
}

/**
 * `code_find_symbol`: where a name is declared across the project, in one call. Aliases (renamed imports, re-export
 * chains) resolve to the real declaration, which lists them in `reexportedFrom`.
 */
export function createCodeFindSymbol(deps: CodeDeps): Tool {
  return {
    ...defineBatchTool({
      name: CODE_FIND_SYMBOL_TOOL_NAME,
      description: 'Find where a symbol is declared in the TypeScript/JavaScript project ("where is X defined?") in one call: path, line, kind, signature, container and whether it is exported, ranked. Renamed imports and re-exports resolve to the real definition. Use code_references for usages.',
      item: findItem, maxItems: MAX_CODE_ITEMS,
      deterministic: false, cache: true, cacheTtlMs: CODE_CACHE_TTL_MS,
      validity: async ({ items }) => codeValidity({ deps, paths: (await Promise.all(items.map(({ scope }) => searchRoots({ deps, ...(scope == null ? {} : { scope }) })))).flatMap(({ roots }) => roots) }),
      contentKind: 'search-hits', fidelity: 'verbatim', maxResultTokens: FIND_MAX_RESULT_TOKENS, timeoutMs: CODE_TOOL_TIMEOUT_MS,
      describeActivity: ({ items }) => ({ title: items.length === 1 ? `Finding ${items[0]?.name ?? ''}` : `Finding ${items.length} symbols` }),
      runItem: ({ name, kind, scope, exportedOnly = false, maxResults = DEFAULT_MAX_RESULTS }) => deps.programs.hold(async () => {
        const { definitions, isIndexTruncated } = await collectDefinitions({ deps, name, ...(scope == null ? {} : { scope }) });
        const kept = rank({ name, definitions: definitions.filter(definition => (kind == null || definition.kind === kind) && (!exportedOnly || definition.exported)) });
        return { name, total: kept.length, truncated: kept.length > maxResults, definitions: kept.slice(0, maxResults), ...(isIndexTruncated ? { incompleteIndex: true } : {}) };
      }),
    }),
    ...BATCH_RESULT_HELPERS_WITH_REASONS,
  };
}
