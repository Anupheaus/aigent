function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Copies `value` with object keys sorted at every depth and `undefined` object values dropped (as JSON would). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined)
    .map(key => [key, sortKeys(value[key])]));
}

/** JSON whose text depends only on the data, never on key insertion order, so it can be hashed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
