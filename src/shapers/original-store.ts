/** Prefix of every original handle (`H1`, `H2`...). */
const HANDLE_PREFIX = 'H';

/** Run state: the verbatim text of every shaped result, retrievable through `result_original`. */
export interface OriginalStore {
  /** Keeps `text` and returns its new handle, numbered per run. */
  put(text: string): string;
  get(handle: string): string | undefined;
  handles(): string[];
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
  };
}
