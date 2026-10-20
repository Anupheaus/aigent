import { createAigentError } from '../core/aigent-error.js';

/** One record on its way to the store. */
export interface RedactableRecord {
  /** e.g. `runs`, `traces`, `responses`, `feedback`. */
  collection: string;
  key: string;
  value: unknown;
}

/**
 * Consumer hook applied to every record of every collection before it reaches the store. It receives a copy and
 * returns the record to store; it may change `value` only (collection and key identify the record).
 */
export type Redact = (record: RedactableRecord) => RedactableRecord;

export interface ApplyRedactParams {
  redact?: Redact;
  record: RedactableRecord;
}

function isRedactableRecord(value: unknown): value is RedactableRecord {
  return typeof value === 'object' && value !== null && 'collection' in value && 'key' in value && 'value' in value;
}

/** Runs the hook on a copy of the record; throws when the hook breaks its contract, so nothing un-redacted is written instead. */
export function applyRedact(params: ApplyRedactParams): RedactableRecord {
  const { redact, record } = params;
  if (redact == null) return record;
  const { collection, key } = record;
  const redacted: unknown = redact(structuredClone(record));
  if (!isRedactableRecord(redacted) || redacted.collection !== collection || redacted.key !== key) {
    throw createAigentError({
      code: 'invalid_definition',
      message: `redact for '${collection}/${key}' must return the record with the same collection and key (it may change only value)`,
      details: { collection, key },
    });
  }
  return redacted;
}
