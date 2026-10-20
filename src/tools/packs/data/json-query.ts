import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool } from '../../tool-types.js';
import { queryJsonPath } from '../json-path.js';
import { DATA_TOOL_BASE, guarded } from './data-shared.js';

export const JSON_QUERY_TOOL_NAME = 'json_query';

const jsonItem = z.object({
  json: z.string().describe('The JSON document, as text'),
  query: z.string().min(1).describe("JSONPath subset: $, .key, ['key'], [n], [*], ..key, [?(@.a == 1)] (== != < <= > >=), [?(@.a)]"),
}).strict();

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw toolFailure({ code: 'invalid_json', message: `The json text is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, suggestion: 'Pass the document exactly as JSON text' });
  }
}

/** `json_query`: JSONPath-subset queries over inline JSON text. */
export function createJsonQuery(): Tool {
  return defineBatchTool({
    ...DATA_TOOL_BASE,
    name: JSON_QUERY_TOOL_NAME,
    description: 'Query JSON text with a JSONPath subset ($, .key, [\'key\'], [n], *, ..key, [?(@.a op literal)]); returns the matching values in document order. Not supported: exponent number literals, escaped quotes inside keys, spaces inside ?( @...), and results over 100000 values.',
    item: jsonItem, contentKind: 'structured-data', fidelity: 'verbatim',
    describeActivity: ({ items }) => ({ title: items.length === 1 ? 'Querying JSON' : `Running ${items.length} JSON queries` }),
    runItem: async ({ json, query }) => {
      const document = parseJson(json);
      const matches = guarded(() => queryJsonPath({ document, query }));
      return { matches, count: matches.length };
    },
  });
}
