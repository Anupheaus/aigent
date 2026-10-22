import type { PolicyContext, PolicyResult } from './policy-types.js';

/** Most items one batch call carries (the fs pack's limit). */
export const MAX_ITEMS_PER_CALL = 50;

/** One batch tool's items for this turn; split into calls of at most `perCall` items. */
export interface ToolRequest {
  tool: string;
  items: Record<string, unknown>[];
  perCall?: number;
}

/** One item's outcome, in request order. */
export interface ItemOutcome {
  item: Record<string, unknown>;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

/** A quarantined result (instruction-like text found) is still data: the JSON between its `<<<` and `>>>` markers. */
function unquarantine(result: unknown): unknown {
  if (typeof result !== 'string') return result;
  const start = result.indexOf('<<<\n');
  const end = result.lastIndexOf('\n>>>');
  if (start < 0 || end <= start) return result;
  try {
    return JSON.parse(result.slice(start + 4, end));
  } catch {
    // Not JSON inside the markers: left as text.
    return result;
  }
}

function entriesOf(result: PolicyResult): { ok: boolean; result?: unknown; error?: { message?: string } }[] {
  const value = unquarantine(result.result);
  if (!result.ok || !Array.isArray(value)) return [];
  return value as { ok: boolean; result?: unknown; error?: { message?: string } }[];
}

/**
 * Runs every request in ONE model turn (all calls side by side) and returns each request's item outcomes. A failed
 * call fails all its items, with the call's error message.
 */
export async function runTurn(params: { ctx: PolicyContext; requests: ToolRequest[] }): Promise<ItemOutcome[][]> {
  const { ctx, requests } = params;
  const chunks = requests.map(({ tool, items, perCall = MAX_ITEMS_PER_CALL }) => {
    const calls: Record<string, unknown>[][] = [];
    for (let start = 0; start < items.length; start += perCall) calls.push(items.slice(start, start + perCall));
    return { tool, calls };
  });
  const flat = chunks.flatMap(({ tool, calls }) => calls.map(items => ({ name: tool, args: { items } })));
  if (flat.length === 0) return requests.map(() => []);
  const results = await ctx.call(flat);
  let position = 0;
  return chunks.map(({ calls }) => calls.flatMap(items => {
    const result = results[position];
    position += 1;
    const entries = result == null ? [] : entriesOf(result);
    return items.map((item, index): ItemOutcome => {
      const entry = entries[index];
      if (entry == null) return { item, ok: false, error: result?.error?.message ?? 'no result' };
      return entry.ok ? { item, ok: true, result: entry.result as Record<string, unknown> } : { item, ok: false, error: entry.error?.message ?? 'failed' };
    });
  }));
}
