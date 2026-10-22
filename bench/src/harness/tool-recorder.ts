import type { Tool } from '../../../src/index.js';

/** Per-tool counts of what a run asked for and got back. */
export interface ToolRecord {
  calls: number;
  items: number;
  /** Characters of the serialised results returned. */
  resultChars: number;
}

export interface ToolRecorder {
  tools: Tool[];
  records(): Record<string, ToolRecord>;
}

/** Wraps tools so every call is counted (calls, batch items, result size) without changing what they do. */
export function recordTools(tools: Tool[]): ToolRecorder {
  const records: Record<string, ToolRecord> = {};
  const wrapped = tools.map((tool): Tool => ({
    ...tool,
    run: async (args, context) => {
      const record = records[tool.name] ?? { calls: 0, items: 0, resultChars: 0 };
      records[tool.name] = record;
      record.calls += 1;
      const items = (args as { items?: unknown[] } | undefined)?.items;
      record.items += Array.isArray(items) ? items.length : 1;
      const result = await tool.run(args, context);
      record.resultChars += JSON.stringify(result ?? null).length;
      return result;
    },
  }));
  return { tools: wrapped, records: () => structuredClone(records) };
}
