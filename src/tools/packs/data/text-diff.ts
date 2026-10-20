import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { diffLines, diffStats, splitLines, unifiedDiff } from '../diff.js';
import { DATA_TOOL_BASE } from './data-shared.js';

export const TEXT_DIFF_TOOL_NAME = 'text_diff';
const MAX_CONTEXT = 10;
const DEFAULT_CONTEXT = 3;

const diffItem = z.object({
  a: z.string().describe('The original text'),
  b: z.string().describe('The changed text'),
  context: z.number().int().min(0).max(MAX_CONTEXT).optional().describe(`Unchanged lines around each change (default ${DEFAULT_CONTEXT})`),
}).strict();

/** `text_diff`: a unified line diff of two texts, with counts. */
export function createTextDiff(): Tool {
  return defineBatchTool({
    ...DATA_TOOL_BASE,
    name: TEXT_DIFF_TOOL_NAME,
    description: 'Compare two texts line by line: a unified diff plus added, removed and unchanged line counts.',
    item: diffItem, contentKind: 'prose', fidelity: 'verbatim',
    describeActivity: ({ items }) => ({ title: items.length === 1 ? 'Comparing texts' : `Comparing ${items.length} text pairs` }),
    runItem: async ({ a, b, context = DEFAULT_CONTEXT }) => {
      const ops = diffLines({ a: splitLines(a), b: splitLines(b) });
      const { added, removed } = diffStats(ops);
      return { identical: a === b, added, removed, unchanged: ops.length - added - removed, diff: unifiedDiff({ a, b, context }) };
    },
  });
}
