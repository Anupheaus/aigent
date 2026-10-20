/** A JSON-like value with every string passed through `change` (objects and arrays copied only where something changed). */
export function mapStrings(params: { value: unknown; change(text: string): string }): unknown {
  const { value, change } = params;
  if (typeof value === 'string') return change(value);
  if (Array.isArray(value)) {
    const mapped = value.map(entry => mapStrings({ value: entry, change }));
    return mapped.some((entry, index) => entry !== value[index]) ? mapped : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value);
  const mapped = entries.map(([key, entry]) => [key, mapStrings({ value: entry, change })] as const);
  return mapped.some(([, entry], index) => entry !== entries[index]?.[1]) ? Object.fromEntries(mapped) : value;
}

/** Every string inside a JSON-like value, in order. */
export function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(stringsOf);
}
