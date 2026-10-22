import { CHARS_PER_TOKEN } from '../../../telemetry/estimate-tokens.js';

/** Longest text value returned; longer values are cut with a marker saying how much is missing. */
export const MAX_VALUE_CHARS = 2_000;
/** Part of an item's share of the result budget its documents may fill; the rest covers the other fields. */
const BUDGET_FILL = 0.85;

/** Documents fitted to a budget, and what fitting did. */
export interface FittedDocs {
  docs: Record<string, unknown>[];
  /** Text values cut to `MAX_VALUE_CHARS`. */
  cutValues: number;
  /** Trailing documents left out to fit. */
  dropped: number;
}

function cutText(params: { value: unknown; counter: { cut: number } }): unknown {
  const { value, counter } = params;
  if (typeof value === 'string') {
    if (value.length <= MAX_VALUE_CHARS) return value;
    counter.cut += 1;
    return `${value.slice(0, MAX_VALUE_CHARS)}…[truncated: ${value.length - MAX_VALUE_CHARS} more characters]`;
  }
  if (Array.isArray(value)) return value.map(element => cutText({ value: element, counter }));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cutText({ value: child, counter })]));
}

/** One item's share of a call's result budget, in JSON characters. */
export function itemBudgetChars(params: { maxResultTokens: number; itemCount: number }): number {
  const { maxResultTokens, itemCount } = params;
  return Math.floor((maxResultTokens * CHARS_PER_TOKEN * BUDGET_FILL) / Math.max(1, itemCount));
}

/** Long text values cut with a marker, then the leading documents whose JSON fits `maxJsonChars` (at least one). */
export function fitDocs(params: { docs: Record<string, unknown>[]; maxJsonChars: number }): FittedDocs {
  const { docs, maxJsonChars } = params;
  const counter = { cut: 0 };
  const trimmed = docs.map(doc => cutText({ value: doc, counter }) as Record<string, unknown>);
  const kept: Record<string, unknown>[] = [];
  let used = 0;
  for (const doc of trimmed) {
    used += JSON.stringify(doc).length + 1;
    // The first document is always kept (already cut), so a call never returns nothing for want of budget.
    if (used > maxJsonChars && kept.length > 0) break;
    kept.push(doc);
  }
  return { docs: kept, cutValues: counter.cut, dropped: trimmed.length - kept.length };
}
