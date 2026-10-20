import { z } from 'zod';
import { BATCH_RESULT_HELPERS } from '../tools/batch-entries.js';
import type { BatchEntry } from '../tools/batch-entries.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import type { OriginalStore } from './original-store.js';

export const RESULT_ORIGINAL_TOOL_NAME = 'result_original';
const MAX_HANDLES = 10;
/** Budget for the originals in one call; larger ones come back truncated with a marker. */
const RESULT_ORIGINAL_MAX_TOKENS = 25_000;

export interface CreateResultOriginalToolParams {
  /** The run's originals. */
  originals: OriginalStore;
}

/** Built-in tool returning the verbatim originals behind shaped results. Registered only when a tool declares `lossy-ok`. */
export function createResultOriginalTool(params: CreateResultOriginalToolParams): Tool {
  const { originals } = params;
  const tool = defineTool({
    name: RESULT_ORIGINAL_TOOL_NAME,
    description: 'Get the full, unshaped original of results that were shortened (their shaping notes name a handle such as H3). Up to 10 handles per call.',
    args: z.object({ handles: z.array(z.string().min(1)).min(1).max(MAX_HANDLES) }).strict(),
    deterministic: false,
    cache: false,
    maxResultTokens: RESULT_ORIGINAL_MAX_TOKENS,
    describeActivity: ({ handles }) => ({ title: `Fetching ${handles.length} original results`, detail: handles.join(', ') }),
    run: async ({ handles }) => handles.map((handle, index): BatchEntry => {
      const text = originals.get(handle);
      if (text != null) return { index, ok: true, result: { handle, text } };
      const known = originals.handles();
      return {
        index, ok: false,
        error: {
          category: 'validation', code: 'unknown_handle', retryable: false,
          message: `No original is kept under handle '${handle}' in this run`,
          suggestion: known.length === 0 ? 'No result of this run was shaped.' : `Known handles: ${known.join(', ')}`,
        },
      };
    }),
  });
  return { ...tool, ...BATCH_RESULT_HELPERS };
}
