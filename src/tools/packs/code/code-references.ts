import { z } from 'zod';
import { BATCH_RESULT_HELPERS_WITH_REASONS } from '../../batch-entries.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import type { CodeSkips } from './code-files.js';
import { CODE_CACHE_TTL_MS, CODE_TOOL_TIMEOUT_MS, lineOf, lineText, MAX_CODE_ITEMS, sourceFor } from './code-shared.js';
import type { CodeDeps } from './code-shared.js';
import { codeValidity, pathsTitle } from './code-validity.js';
import { field } from './declarations.js';
import { targetName, usageKind } from './reference-nodes.js';
import type { UsageKind } from './reference-nodes.js';

export const CODE_REFERENCES_TOOL_NAME = 'code_references';
const DEFAULT_MAX_RESULTS = 200;
const MAX_RESULTS = 1_000;
const REFERENCES_MAX_RESULT_TOKENS = 8_000;

const referencesItem = z.object({
  path: z.string().min(1).describe('The file the symbol is in (or used in)'),
  line: z.number().int().min(1).optional().describe('1-based line of the name'),
  character: z.number().int().min(1).optional().describe('1-based column of the name on that line'),
  symbol: z.string().min(1).optional().describe('The name, instead of (or to find on) the line'),
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`Default ${DEFAULT_MAX_RESULTS}`),
}).strict();

interface Usage {
  path: string;
  line: number;
  character: number;
  text: string;
  kind: UsageKind;
}

/** The code files the program left out, by reason (only reasons that occurred), when there are any. */
function filesSkippedOf(codeSkips: CodeSkips): { filesSkipped?: Partial<CodeSkips> } {
  const counted = Object.fromEntries(Object.entries(codeSkips).filter(([, count]) => count > 0));
  return Object.keys(counted).length === 0 ? {} : { filesSkipped: counted };
}

/** `code_references`: every usage of a symbol across the project, as the compiler resolves it, grouped by file. */
export function createCodeReferences(deps: CodeDeps): Tool {
  return {
    ...defineBatchTool({
      name: CODE_REFERENCES_TOOL_NAME,
      description: 'Find every usage of a TypeScript/JavaScript symbol across the project as the compiler resolves it (through imports, renames and re-exports), grouped by file: line, column, line text and kind (definition, import, call, type-ref, other). Point at the name by line and character, or give its symbol name and file.',
      item: referencesItem, maxItems: MAX_CODE_ITEMS,
      deterministic: false, cache: true, cacheTtlMs: CODE_CACHE_TTL_MS, validity: ({ items }) => codeValidity({ deps, paths: items.map(({ path }) => path) }),
      contentKind: 'search-hits', fidelity: 'verbatim', maxResultTokens: REFERENCES_MAX_RESULT_TOKENS, timeoutMs: CODE_TOOL_TIMEOUT_MS, acceptsAliases: true,
      describeActivity: ({ items }) => ({ title: pathsTitle({ verb: 'Finding usages in', paths: items.map(({ path }) => path) }) }),
      runItem: ({ path, line, character, symbol, maxResults = DEFAULT_MAX_RESULTS }) => deps.programs.hold(async () => {
        const { program, source, path: canonical } = await sourceFor({ deps, path });
        const kinds = program.syntaxKind;
        const name = targetName({ source, kinds, ...(line == null ? {} : { line }), ...(character == null ? {} : { character }), ...(symbol == null ? {} : { symbol }) });
        const seen = new Set<string>();
        const usages: Usage[] = [];
        let skipped = 0;
        for (const { references } of await program.project.checker.getReferencedSymbolsForNode(name, name.getStart())) {
          for (const handle of references) {
            const ownPath = program.ownPath(handle.path);
            const node = ownPath == null ? undefined : await handle.resolve();
            // Library declarations and files outside the program (never read) are counted, not shown.
            if (ownPath == null || node == null) { skipped += 1; continue; }
            const start = node.getStart();
            if (seen.has(`${ownPath}\u0000${start}`)) continue;
            seen.add(`${ownPath}\u0000${start}`);
            const file = node.getSourceFile();
            const usageLine = lineOf({ source: file, position: start });
            usages.push({ path: ownPath, line: usageLine, character: start - (file.getLineStarts()[usageLine - 1] ?? 0) + 1, text: lineText({ source: file, line: usageLine }), kind: usageKind({ node, kinds }) });
          }
        }
        usages.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.character - right.character);
        const files = new Map<string, Omit<Usage, 'path'>[]>();
        for (const { path: usagePath, ...usage } of usages.slice(0, maxResults)) files.set(usagePath, [...files.get(usagePath) ?? [], usage]);
        return {
          path: canonical, symbol: field<string>(name, 'text') ?? '', total: usages.length, skipped, truncated: usages.length > maxResults,
          files: [...files.entries()].map(([filePath, fileUsages]) => ({ path: filePath, usages: fileUsages })), ...(program.truncated ? { incompleteIndex: true } : {}),
          ...filesSkippedOf(program.files.codeSkips),
        };
      }),
    }),
    ...BATCH_RESULT_HELPERS_WITH_REASONS,
  };
}
