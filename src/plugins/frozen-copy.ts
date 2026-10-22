/** Freezes `value` and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return value;
}

/** A plain copy of `value`: a structured clone, or a JSON round trip for values a clone refuses (functions inside). */
function plainCopy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // Not cloneable (e.g. a function inside a tool result): JSON drops what cannot be represented, which is enough for an observer.
    return JSON.parse(JSON.stringify(value) ?? 'null') as T;
  }
}

/** A deep-frozen copy, so an observer can never change the live object it was shown. */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(plainCopy(value));
}
