import { z } from 'zod';
import { BATCH_RESULT_HELPERS_WITH_REASONS } from '../../batch-entries.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { CODE_CACHE_TTL_MS, CODE_TOOL_TIMEOUT_MS, MAX_CODE_ITEMS, sourceFor } from './code-shared.js';
import type { CodeDeps } from './code-shared.js';
import { codeValidity, pathsTitle } from './code-validity.js';
import { outlineOf } from './declarations.js';

export const CODE_OUTLINE_TOOL_NAME = 'code_outline';
const OUTLINE_MAX_RESULT_TOKENS = 8_000;

const outlineItem = z.object({ path: z.string().min(1).describe('A .ts, .tsx, .js or .jsx file: absolute, or relative to the workspace root') }).strict();

/** `code_outline`: a file's declarations (functions, classes and members, interfaces, types, enums, constants) without bodies. */
export function createCodeOutline(deps: CodeDeps): Tool {
  return {
    ...defineBatchTool({
      name: CODE_OUTLINE_TOOL_NAME,
      description: 'Outline TypeScript/JavaScript files: every declaration (functions with overloads, classes with members, interfaces, types, enums, constants, namespaces, re-exports) with kind, line range, whether it is exported and its signature, without bodies. Cheaper than reading the file.',
      item: outlineItem, maxItems: MAX_CODE_ITEMS,
      deterministic: false, cache: true, cacheTtlMs: CODE_CACHE_TTL_MS, validity: ({ items }) => codeValidity({ deps, paths: items.map(({ path }) => path) }),
      contentKind: 'search-hits', fidelity: 'verbatim', maxResultTokens: OUTLINE_MAX_RESULT_TOKENS, timeoutMs: CODE_TOOL_TIMEOUT_MS, acceptsAliases: true,
      describeActivity: ({ items }) => ({ title: pathsTitle({ verb: 'Outlining', paths: items.map(({ path }) => path) }) }),
      runItem: async ({ path }) => {
        const { program, source, path: canonical } = await sourceFor({ deps, path });
        return { path: canonical, symbols: outlineOf({ node: source, kinds: program.syntaxKind }) };
      },
    }),
    ...BATCH_RESULT_HELPERS_WITH_REASONS,
  };
}
