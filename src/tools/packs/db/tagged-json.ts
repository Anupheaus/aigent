/** Deepest nesting converted; anything deeper becomes `{ $truncated: 'depth' }`. */
const MAX_DEPTH = 32;
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A BSON value as the `mongodb` driver gives it: tagged with `_bsontype`. */
interface BsonLike {
  _bsontype: string;
  toHexString?(): string;
  toString(): string;
  toNumber?(): number;
  valueOf?(): unknown;
  buffer?: Uint8Array;
  sub_type?: number;
}

function isBson(value: object): value is BsonLike {
  return typeof (value as Partial<BsonLike>)._bsontype === 'string';
}

function fromBson(value: BsonLike): unknown {
  const type = value._bsontype.toLowerCase();
  if (type === 'objectid') return { $oid: value.toHexString?.() ?? value.toString() };
  if (type === 'decimal128') return { $numberDecimal: value.toString() };
  if (type === 'long') {
    const number = value.toNumber?.() ?? Number(value.toString());
    return Number.isSafeInteger(number) ? number : { $numberLong: value.toString() };
  }
  if (type === 'int32' || type === 'double') return Number(value.valueOf?.() ?? value.toString());
  if (type === 'binary') return { $binary: { base64: Buffer.from(value.buffer ?? new Uint8Array()).toString('base64'), subType: (value.sub_type ?? 0).toString(16).padStart(2, '0') } };
  // Timestamps, MinKey/MaxKey, code and other rare types keep their type name and text form.
  return { $bsontype: value._bsontype, value: value.toString() };
}

function convert(params: { value: unknown; depth: number }): unknown {
  const { value, depth } = params;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $numberDouble: String(value) };
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : { $numberLong: value.toString() };
  if (typeof value !== 'object') return undefined;
  if (depth > MAX_DEPTH) return { $truncated: 'depth' };
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  if (value instanceof RegExp) return { $regex: value.source, $options: value.flags };
  if (value instanceof Uint8Array) return { $binary: { base64: Buffer.from(value).toString('base64'), subType: '00' } };
  if (isBson(value)) return fromBson(value);
  if (Array.isArray(value)) return value.map(element => convert({ value: element, depth: depth + 1 }) ?? null);
  const converted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (PROTOTYPE_KEYS.has(key)) continue;
    const childValue = convert({ value: child, depth: depth + 1 });
    if (childValue !== undefined) converted[key] = childValue;
  }
  return converted;
}

/**
 * A database value as plain JSON (MongoDB extended JSON, relaxed): ObjectId `{ $oid }`, Date `{ $date: ISO text }`,
 * Decimal128 `{ $numberDecimal }`, a Long beyond 2^53 `{ $numberLong }`, binary `{ $binary: { base64, subType } }`,
 * a regular expression `{ $regex, $options }`, NaN and infinities `{ $numberDouble }`; Int32, Double and safe Longs are
 * plain numbers. `undefined` and functions are dropped, prototype keys are never copied.
 */
export function toTaggedJson(value: unknown): unknown {
  return convert({ value, depth: 0 });
}
