export interface WriteQueue {
  /** Runs `write` after every earlier write for the same key; different keys run in parallel. */
  enqueue<T>(key: string, write: () => Promise<T>): Promise<T>;
  /** Resolves when every write queued so far (and any queued while flushing) has settled. */
  flush(): Promise<void>;
}

export function createWriteQueue(): WriteQueue {
  const tails = new Map<string, Promise<void>>();

  function enqueue<T>(key: string, write: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(write);
    // The tail swallows failures so one failed write never poisons the queue; the caller still sees the rejection via `result`.
    const tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }

  async function flush(): Promise<void> {
    while (tails.size > 0) await Promise.all([...tails.values()]);
  }

  return { enqueue, flush };
}
