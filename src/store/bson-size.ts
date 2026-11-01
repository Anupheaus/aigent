/** MongoDB's limit on one stored document, in bytes (16 MiB). */
export const MAX_BSON_DOCUMENT_BYTES = 16_777_216;

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
/** Length prefix of a document or string. */
const LENGTH_BYTES = 4;
const TYPE_BYTES = 1;
const TERMINATOR_BYTES = 1;
const INT32_BYTES = 4;
const DOUBLE_BYTES = 8;
const BOOLEAN_BYTES = 1;

function cstringBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8') + TERMINATOR_BYTES;
}

function valueBytes(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return LENGTH_BYTES + cstringBytes(value);
  if (typeof value === 'boolean') return BOOLEAN_BYTES;
  // The Node driver stores an integer that fits in 32 bits as int32 and every other number as a double.
  if (typeof value === 'number') return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX ? INT32_BYTES : DOUBLE_BYTES;
  if (Array.isArray(value)) return documentBytes(value.map((element, position) => [String(position), element] as const));
  if (typeof value === 'object') return documentBytes(Object.entries(value));
  return DOUBLE_BYTES;
}

function documentBytes(fields: readonly (readonly [string, unknown])[]): number {
  let total = LENGTH_BYTES + TERMINATOR_BYTES;
  for (const [field, value] of fields) total += TYPE_BYTES + cstringBytes(field) + valueBytes(value);
  return total;
}

/** The size the Node driver gives a plain JSON-like document in BSON (strings, numbers, booleans, null, arrays, objects). */
export function bsonSize(document: Record<string, unknown>): number {
  return documentBytes(Object.entries(document));
}
