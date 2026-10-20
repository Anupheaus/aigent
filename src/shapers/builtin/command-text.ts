/** Fields of a structured command result that hold the program's output text. */
const OUTPUT_FIELDS = ['stdout', 'stderr'] as const;
/** Batch results nest each item's result one level down (`[{ index, ok, result }]`). */
const MAX_NESTING = 3;

function mapValue(params: { value: unknown; clean(text: string): string; depth: number }): unknown {
  const { value, clean, depth } = params;
  if (typeof value === 'string') return clean(value);
  if (depth >= MAX_NESTING || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(entry => mapValue({ value: entry, clean, depth: depth + 1 }));
  const record = value as Record<string, unknown>;
  // An item asked for byte-faithful output: never touched.
  if (record.raw === true) return value;
  const next: Record<string, unknown> = { ...record };
  for (const field of OUTPUT_FIELDS) if (typeof record[field] === 'string') next[field] = clean(record[field]);
  if (typeof record.result === 'object' && record.result !== null) next.result = mapValue({ value: record.result, clean, depth: depth + 1 });
  return next;
}

/**
 * Applies `clean` to command output: a string result itself, or the `stdout` and `stderr` of a structured result (batch
 * entries included), skipping any result marked `raw: true`. Undefined when nothing changed, so a shaper can decline.
 */
export function mapCommandOutput(params: { value: unknown; clean(text: string): string }): unknown {
  const { value, clean } = params;
  let isChanged = false;
  const tracked = (text: string): string => {
    const cleaned = clean(text);
    if (cleaned !== text) isChanged = true;
    return cleaned;
  };
  const mapped = mapValue({ value, clean: tracked, depth: 0 });
  return isChanged ? mapped : undefined;
}
