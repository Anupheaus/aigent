import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool } from '../../tool-types.js';
import { diffStats, diffTexts, renderUnifiedDiff } from '../diff.js';
import { DATA_TOOL_BASE } from './data-shared.js';

export const TEXT_DIFF_TOOL_NAME = 'text_diff';
/** Largest text accepted on either side. */
export const MAX_TEXT_DIFF_CHARS = 1_000_000;
/** Most lines accepted on either side. */
export const MAX_TEXT_DIFF_LINES = 100_000;
const MAX_CONTEXT = 10;
const DEFAULT_CONTEXT = 3;

const diffItem = z.object({
  a: z.string().describe(`The original text (at most ${MAX_TEXT_DIFF_CHARS} characters and ${MAX_TEXT_DIFF_LINES} lines)`),
  b: z.string().describe('The changed text (same limits)'),
  context: z.number().int().min(0).max(MAX_CONTEXT).optional().describe(`Unchanged lines around each change (default ${DEFAULT_CONTEXT})`),
}).strict();

function lineCount(text: string): number {
  let count = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1;
  return count;
}

/** Refuses a side over the size limits before any diffing, so one call cannot exhaust memory or time. */
function checkSize(params: { side: 'a' | 'b'; text: string }): void {
  const { side, text } = params;
  if (text.length > MAX_TEXT_DIFF_CHARS) throw toolFailure({ code: 'input_too_large', message: `Text ${side} has ${text.length} characters; the limit is ${MAX_TEXT_DIFF_CHARS}`, suggestion: 'Diff smaller parts of the texts' });
  const lines = lineCount(text);
  if (lines > MAX_TEXT_DIFF_LINES) throw toolFailure({ code: 'input_too_large', message: `Text ${side} has ${lines} lines; the limit is ${MAX_TEXT_DIFF_LINES}`, suggestion: 'Diff smaller parts of the texts' });
}

/** `text_diff`: a unified line diff of two texts, with counts. */
export function createTextDiff(): Tool {
  return defineBatchTool({
    ...DATA_TOOL_BASE,
    name: TEXT_DIFF_TOOL_NAME,
    description: 'Compare two texts line by line: a unified diff plus added, removed and unchanged line counts. Very different large texts get a correct but not necessarily shortest diff (minimal: false).',
    item: diffItem, contentKind: 'prose', fidelity: 'verbatim',
    describeActivity: ({ items }) => ({ title: items.length === 1 ? 'Comparing texts' : `Comparing ${items.length} text pairs` }),
    runItem: async ({ a, b, context = DEFAULT_CONTEXT }) => {
      checkSize({ side: 'a', text: a });
      checkSize({ side: 'b', text: b });
      const { ops, isMinimal } = diffTexts({ a, b });
      const { added, removed } = diffStats(ops);
      return { identical: a === b, added, removed, unchanged: ops.length - added - removed, minimal: isMinimal, diff: renderUnifiedDiff({ ops, context }) };
    },
  });
}
