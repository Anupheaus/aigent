export interface ParseRetryAfterParams {
  /** The raw `retry-after` header value, or null when absent. */
  value: string | null;
  /** Milliseconds since the epoch, for the HTTP-date form. */
  now: number;
}

const MS_PER_SECOND = 1_000;
/** Delay-seconds as RFC 9110 allows it (we also accept a fraction, which some proxies send). */
const DELAY_SECONDS = /^\d+(\.\d+)?$/;
/** HTTP dates always name a day or month; this stops `Date.parse` reading `-1` or `12` as a year. */
const HAS_LETTER = /[a-z]/i;

/**
 * Milliseconds a server asked us to wait: `retry-after` is either delay-seconds or an HTTP date. A date in the past
 * means no wait (0). Undefined when the header is absent or unreadable.
 */
export function parseRetryAfterMs(params: ParseRetryAfterParams): number | undefined {
  const { value, now } = params;
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return undefined;
  if (DELAY_SECONDS.test(trimmed)) return Math.round(Number(trimmed) * MS_PER_SECOND);
  const date = HAS_LETTER.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
