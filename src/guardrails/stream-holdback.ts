/** Default characters of streamed text held back so a check can still change them before display. */
export const DEFAULT_HOLD_BACK_CHARS = 64;

export interface CreateStreamHoldbackParams {
  holdBackChars?: number;
  /** Where the unreleased text stops being safe to release (e.g. a secret that may still be growing). */
  openStart?(text: string): number | undefined;
  /** Spans a release must never cut through (a complete secret is released whole, so it is checked whole). */
  spans?(text: string): { matchStart: number; matchEnd: number }[];
  /** Checks a released segment; what it returns is what is emitted. */
  release(segment: string): string;
}

export interface StreamHoldback {
  /** Adds streamed text; returns what may be emitted now (possibly ''). */
  push(text: string): string;
  /** Releases the rest at the end of the stream. */
  end(): string;
}

/**
 * Holds back the tail of streamed text so a check sees each secret whole before any of it is displayed: the last
 * `holdBackChars` characters, and everything from where a secret may still be growing. Emitted text is exactly the
 * checked text of each released segment.
 */
export function createStreamHoldback(params: CreateStreamHoldbackParams): StreamHoldback {
  const { holdBackChars = DEFAULT_HOLD_BACK_CHARS, openStart, spans, release } = params;
  let pending = '';

  function safeCut(): number {
    let cut = Math.max(0, pending.length - holdBackChars);
    const open = openStart?.(pending);
    if (open != null) cut = Math.min(cut, open);
    // Never through a complete secret: it is released whole, later.
    for (const { matchStart, matchEnd } of spans?.(pending) ?? []) if (matchStart < cut && cut < matchEnd) cut = matchStart;
    return cut;
  }

  return {
    push: text => {
      pending += text;
      const cut = safeCut();
      if (cut === 0) return '';
      const segment = pending.slice(0, cut);
      pending = pending.slice(cut);
      return release(segment);
    },
    end: () => {
      const segment = pending;
      pending = '';
      return segment === '' ? '' : release(segment);
    },
  };
}
