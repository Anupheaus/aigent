import { createAigentError } from '../core/aigent-error.js';
import type { ListOptions, Store, StoredRecord } from './store-types.js';

type Where = ListOptions['where'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldValue(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/** Refuses a `where` whose values a store could not compare exactly (objects, arrays, NaN, infinities, undefined). */
export function checkWhere(where: Where): void {
  for (const [field, expected] of Object.entries(where ?? {})) {
    if (isFieldValue(expected)) continue;
    throw createAigentError({
      code: 'invalid_input',
      message: `list where '${field}' must be a string, finite number, boolean or null, got ${expected === undefined ? 'undefined' : JSON.stringify(expected) ?? String(expected)}`,
      details: { field },
    });
  }
}

/** Whether a record's value passes `where` (the rule every store shares, see `ListOptions.where`). */
export function matchesWhere(params: { value: unknown; where: Where }): boolean {
  const { value, where } = params;
  checkWhere(where);
  const entries = Object.entries(where ?? {});
  if (entries.length === 0) return true;
  if (!isPlainObject(value)) return false;
  return entries.every(([field, expected]) => Object.hasOwn(value, field) && value[field] === expected);
}

/**
 * A collection's records that pass `where`: the store is asked for them (so one with an index reads only those), and
 * the result is filtered again, because a store written before `list` took options returns every record.
 */
export async function listWhere<T>(params: { store: Store; collection: string; where: NonNullable<Where> }): Promise<StoredRecord<T>[]> {
  const { store, collection, where } = params;
  checkWhere(where);
  const records = await store.list<T>(collection, { where });
  return records.filter(({ value }) => matchesWhere({ value, where }));
}
