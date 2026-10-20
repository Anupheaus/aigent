/** Shown when a value cannot be turned into a string at all. */
const UNPRINTABLE_VALUE = '<unprintable value>';

/**
 * Turns any value into a string without ever throwing. Thrown values come from consumer code, so they may be a
 * null-prototype object or have a throwing `toString`, where `String(value)` itself throws.
 */
export function describeValue(value: unknown): string {
  try {
    return String(value);
  } catch { // String() throws for hostile values; fall back to the built-in tag, which cannot throw for ordinary objects
    try {
      return Object.prototype.toString.call(value);
    } catch { // a Proxy can still throw from Symbol.toStringTag; the fixed text is the last resort
      return UNPRINTABLE_VALUE;
    }
  }
}

/** The message of an Error, or a safe description of any other thrown value. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : describeValue(error);
}
