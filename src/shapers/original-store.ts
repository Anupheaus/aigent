/** Prefix of every original handle (`H1`, `H2`...). */
const HANDLE_PREFIX = 'H';

/** Run state: the verbatim text of every shaped result, retrievable through `result_original`. */
export interface OriginalStore {
  /** Keeps `text` and returns its new handle, numbered per run. */
  put(text: string): string;
  get(handle: string): string | undefined;
  handles(): string[];
  /** Every `[handle, text]`, in issue order (for checkpoints). */
  entries(): [string, string][];
  /** Puts back entries from a checkpoint; later handles continue after them. */
  restore(entries: readonly [string, string][]): void;
}

export function createOriginalStore(): OriginalStore {
  const byHandle = new Map<string, string>();
  return {
    put: text => {
      const handle = `${HANDLE_PREFIX}${byHandle.size + 1}`;
      byHandle.set(handle, text);
      return handle;
    },
    get: handle => byHandle.get(handle),
    handles: () => [...byHandle.keys()],
    entries: () => [...byHandle.entries()],
    restore: entries => { for (const [handle, text] of entries) byHandle.set(handle, text); },
  };
}
