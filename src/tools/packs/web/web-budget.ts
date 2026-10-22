import { CHARS_PER_TOKEN } from '../../../telemetry/estimate-tokens.js';

/** Part of the result budget the items' own JSON may fill; the rest covers each entry's envelope and margin. */
const BUDGET_FILL = 0.9;
/** JSON characters reserved per item for the fields added after its text is sized (`nextOffset`, `totalChars`...). */
const ITEM_MARGIN_CHARS = 120;
/** A page is never sized below this, so a full batch still shows something of every item. */
const MIN_TEXT_CHARS = 200;

/** One item's share of a batch's result budget, in JSON characters. */
export function itemShareChars(params: { maxResultTokens: number; itemCount: number }): number {
  const { maxResultTokens, itemCount } = params;
  return Math.floor((maxResultTokens * CHARS_PER_TOKEN * BUDGET_FILL) / Math.max(1, itemCount));
}

const HIGH_SURROGATE_FIRST = 0xd8_00;
const HIGH_SURROGATE_LAST = 0xdb_ff;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST;
}

/** Characters `text` takes inside a JSON string (quotes, backslashes and control characters are escaped). */
export function jsonChars(text: string): number {
  return JSON.stringify(text).length - 2;
}

/** A window of a longer text: where the next window starts while any text is left. */
export interface TextPage {
  text: string;
  /** Characters of the whole text. */
  totalChars: number;
  /** Where the next page starts (pass it back as `offset`); absent on the last page. */
  nextOffset?: number;
}

/**
 * The text from `offset`, at most `maxChars` characters and at most `maxJsonChars` once JSON-escaped, never ending
 * inside a surrogate pair.
 */
export function pageOfText(params: { text: string; offset: number; maxChars: number; maxJsonChars: number }): TextPage {
  const { text, offset, maxChars } = params;
  const maxJsonChars = Math.max(MIN_TEXT_CHARS, params.maxJsonChars);
  const start = Math.min(offset, text.length);
  // A cut between the halves of a surrogate pair would leave a lone half (escaped, and not a character).
  const whole = (cut: number): number => (cut > start + 1 && cut < text.length && isHighSurrogate(text.charCodeAt(cut - 1)) ? cut - 1 : cut);
  let end = whole(Math.min(text.length, start + maxChars, start + maxJsonChars));
  // Escapes only lengthen the text, so shrinking by the excess converges in a few steps.
  for (let excess = jsonChars(text.slice(start, end)) - maxJsonChars; excess > 0 && end > start; excess = jsonChars(text.slice(start, end)) - maxJsonChars) end = whole(Math.max(start, end - excess));
  // Every page moves forward, so paging always ends.
  if (end === start && start < text.length) end = start + 1;
  return { text: text.slice(start, end), totalChars: text.length, ...(end < text.length ? { nextOffset: end } : {}) };
}

/** The leading entries of `list` whose JSON fits `maxJsonChars`. */
export function fitList<T>(params: { list: T[]; maxJsonChars: number }): T[] {
  const { list, maxJsonChars } = params;
  let used = 0;
  const kept: T[] = [];
  for (const entry of list) {
    used += JSON.stringify(entry).length + 1;
    if (used > maxJsonChars) break;
    kept.push(entry);
  }
  return kept;
}

/** The JSON characters left for an item's text once its other fields are counted. */
export function textAllowance(params: { shareChars: number; rest: unknown }): number {
  const { shareChars, rest } = params;
  return shareChars - JSON.stringify(rest).length - ITEM_MARGIN_CHARS;
}
