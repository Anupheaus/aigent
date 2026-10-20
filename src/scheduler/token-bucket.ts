export interface TokenBucketOptions {
  /** Most that may be spent in any window. */
  capacity: number;
  windowMs: number;
}

export interface BucketAmountParams {
  amount: number;
  /** Milliseconds since the epoch. */
  now: number;
}

/** A spend that can be corrected later (estimated tokens replaced by actual ones). */
export interface BucketSpend {
  reconcile(actual: number): void;
}

export interface TokenBucket {
  /** True when `amount` fits now. An amount above the capacity fits only when nothing else is in the window. */
  canSpend(params: BucketAmountParams): boolean;
  spend(params: BucketAmountParams): BucketSpend;
  /** Milliseconds until `amount` fits (0 when it fits now). */
  waitMs(params: BucketAmountParams): number;
  /** Amount spent in the window ending at `now`. */
  used(now: number): number;
}

interface SpendEntry {
  at: number;
  amount: number;
}

/**
 * A token bucket whose spent tokens return exactly one window after they were spent. A continuously refilling bucket
 * would let up to twice the capacity through in one window (a full burst, then the refill), which breaks the
 * provider's per-minute limit; returning each spend after a full window keeps every sliding window within capacity.
 */
export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { capacity, windowMs } = options;
  let entries: SpendEntry[] = [];

  function prune(now: number): void {
    entries = entries.filter(({ at }) => at + windowMs > now);
  }

  function used(now: number): number {
    prune(now);
    return entries.reduce((sum, { amount }) => sum + amount, 0);
  }

  function canSpend(params: BucketAmountParams): boolean {
    const { amount, now } = params;
    const spent = used(now);
    return spent + amount <= capacity || spent === 0;
  }

  function spend(params: BucketAmountParams): BucketSpend {
    const { amount, now } = params;
    const entry: SpendEntry = { at: now, amount };
    entries.push(entry);
    return { reconcile: actual => { entry.amount = actual; } };
  }

  function waitMs(params: BucketAmountParams): number {
    const { amount, now } = params;
    if (canSpend(params)) return 0;
    // Entries are in spend order, so they expire in that order too; find the first expiry that makes room.
    let remaining = used(now);
    for (const { at, amount: spent } of entries) {
      remaining -= spent;
      if (remaining + amount <= capacity || remaining === 0) return at + windowMs - now;
    }
    return 0;
  }

  return { canSpend, spend, waitMs, used };
}
