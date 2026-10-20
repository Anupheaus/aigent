/** What eviction needs to know about one live entry. */
export interface IndexedEntry {
  bytes: number;
  lastRequestedAt: number;
}

export interface CacheIndexLimits {
  maxEntries: number;
  maxBytes: number;
}

/** In-memory view of the live entries, for least-recently-requested eviction without listing the store each time. */
export interface CacheIndex {
  /** Adds or refreshes a live entry. */
  touch(key: string, entry: IndexedEntry): void;
  remove(key: string): void;
  /**
   * Keys to evict, least recently requested first, until the live entries fit the limits. `keep` (the entry just
   * stored) is chosen last, so a tie on time never evicts the newest entry while others remain.
   */
  overflow(keep: string): string[];
}

export function createCacheIndex(limits: CacheIndexLimits): CacheIndex {
  const { maxEntries, maxBytes } = limits;
  const entries = new Map<string, IndexedEntry>();

  function totalBytes(): number {
    let total = 0;
    for (const { bytes } of entries.values()) total += bytes;
    return total;
  }

  function overflow(keep: string): string[] {
    let count = entries.size;
    let bytes = totalBytes();
    if (count <= maxEntries && bytes <= maxBytes) return [];
    const order = [...entries.entries()].sort(([leftKey, left], [rightKey, right]) => {
      if (leftKey === keep) return 1;
      if (rightKey === keep) return -1;
      return left.lastRequestedAt - right.lastRequestedAt || leftKey.localeCompare(rightKey);
    });
    const evicted: string[] = [];
    for (const [key, { bytes: entryBytes }] of order) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      evicted.push(key);
      count -= 1;
      bytes -= entryBytes;
    }
    return evicted;
  }

  return {
    touch: (key, entry) => { entries.set(key, entry); },
    remove: key => { entries.delete(key); },
    overflow,
  };
}
