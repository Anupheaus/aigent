import { z } from 'zod';
import { MAX_PROPERTY_DESCRIPTION_CHARS, sanitiseServerText } from './mcp-text.js';

/** Deepest nesting of objects and arrays accepted from a server. */
export const MAX_SCHEMA_DEPTH = 12;

/**
 * An MCP input schema in the strict subset (`args`, a zod object `defineTool` turns back into strict JSON Schema) with
 * every change made to get there (`changes` empty: accepted as is), or why it cannot be expressed.
 */
export type SchemaConversion =
  | { kind: 'strict'; args: z.ZodObject; changes: string[] }
  | { kind: 'rejected'; reason: string };

/** Annotations: dropped silently except `default`, which changes meaning (the model must then send a value). */
const ANNOTATIONS = new Set(['title', 'description', 'examples', '$schema', '$id', '$comment', 'deprecated', 'readOnly', 'writeOnly']);
/** Constraints the strict subset could carry but that are dropped here, each with a change note; the server still enforces them. */
const SERVER_ENFORCED = new Set(['pattern', 'format', 'multipleOf', 'uniqueItems', 'contentEncoding', 'contentMediaType', 'minProperties', 'maxProperties']);
const KEYWORDS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  object: new Set(['type', 'properties', 'required', 'additionalProperties']),
  array: new Set(['type', 'items', 'minItems', 'maxItems']),
  string: new Set(['type', 'enum', 'const', 'minLength', 'maxLength']),
  number: new Set(['type', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  integer: new Set(['type', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  boolean: new Set(['type', 'enum', 'const']),
};
const UNTYPED_KEYWORDS = new Set(['enum', 'const']);
const NULL_TYPE = 'null';

type Literal = string | number | boolean;
type JsonNode = Record<string, unknown>;

/** Thrown inside the walk; caught once at the top. */
interface Rejection {
  rejected: string;
}

function reject(path: string, reason: string): never {
  throw { rejected: `${path}: ${reason}` } satisfies Rejection;
}

function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLiteral(value: unknown): value is Literal {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

interface Walk {
  changes: string[];
}

interface NodeParams {
  node: JsonNode;
  path: string;
  depth: number;
  walk: Walk;
}

/** Splits `type: [X, 'null']` into X plus "nullable"; other unions are rejected. */
function typeOf(params: NodeParams): { type?: string; isNullable: boolean } {
  const { node: { type, enum: values }, path } = params;
  const enumHasNull = Array.isArray(values) && values.includes(null);
  if (Array.isArray(type)) {
    const others = type.filter(entry => entry !== NULL_TYPE);
    if (others.length !== 1 || type.length !== 2 || typeof others[0] !== 'string') reject(path, `type union [${type.map(entry => `'${String(entry)}'`).join(', ')}]`);
    return { type: others[0], isNullable: true };
  }
  if (type !== undefined && typeof type !== 'string') reject(path, 'type must be a string');
  return { ...(type == null ? {} : { type }), isNullable: enumHasNull };
}

function checkKeywords(params: NodeParams & { type?: string }): void {
  const { node, path, walk, type } = params;
  const allowed = type == null ? UNTYPED_KEYWORDS : KEYWORDS_BY_TYPE[type];
  if (allowed == null) reject(path, `unsupported type '${type}'`);
  for (const keyword of Object.keys(node)) {
    if (allowed.has(keyword) || ANNOTATIONS.has(keyword)) continue;
    if (keyword === 'default') { walk.changes.push(`${path}: dropped 'default'`); continue; }
    if (SERVER_ENFORCED.has(keyword)) { walk.changes.push(`${path}: dropped '${keyword}' (the server still validates it)`); continue; }
    reject(path, `unsupported keyword '${keyword}'`);
  }
}

function literalsOf(params: NodeParams): z.ZodType | undefined {
  const { node, path } = params;
  if ('const' in node) {
    if (!isLiteral(node.const)) reject(path, 'const must be a string, number or boolean');
    return z.literal(node.const);
  }
  if (!Array.isArray(node.enum)) return undefined;
  const values = node.enum.filter(value => value !== null);
  if (values.length === 0 || !values.every(isLiteral)) reject(path, 'enum values must be strings, numbers or booleans');
  return values.every(value => typeof value === 'string') ? z.enum(values as [string, ...string[]]) : z.literal(values as Literal[]);
}

function numberSchema(params: NodeParams & { isInteger: boolean }): z.ZodType {
  const { node, isInteger, path, walk } = params;
  let schema = isInteger ? z.number().int() : z.number();
  const minimum = numberOf(node.minimum);
  const maximum = numberOf(node.maximum);
  if (minimum != null) schema = schema.min(minimum);
  if (maximum != null) schema = schema.max(maximum);
  for (const keyword of ['exclusiveMinimum', 'exclusiveMaximum'] as const) {
    const bound = node[keyword];
    // Draft-4 boolean forms cannot be expressed on their own.
    if (typeof bound === 'boolean') { walk.changes.push(`${path}: dropped boolean '${keyword}'`); continue; }
    const value = numberOf(bound);
    if (value != null) schema = keyword === 'exclusiveMinimum' ? schema.gt(value) : schema.lt(value);
  }
  return schema;
}

function stringSchema(node: JsonNode): z.ZodType {
  let schema = z.string();
  const minLength = numberOf(node.minLength);
  const maxLength = numberOf(node.maxLength);
  if (minLength != null) schema = schema.min(minLength);
  if (maxLength != null) schema = schema.max(maxLength);
  return schema;
}

function arraySchema(params: NodeParams): z.ZodType {
  const { node, path, depth, walk } = params;
  if (!isNode(node.items)) reject(path, 'array without items');
  const items = convertValue({ node: node.items, path: `${path}[]`, depth: depth + 1, walk });
  if (items.isNullable) reject(`${path}[]`, 'nullable array items');
  let schema = z.array(items.schema);
  const minItems = numberOf(node.minItems);
  const maxItems = numberOf(node.maxItems);
  if (minItems != null) schema = schema.min(minItems);
  if (maxItems != null) schema = schema.max(maxItems);
  return schema;
}

function objectSchema(params: NodeParams): z.ZodObject {
  const { node, path, depth, walk } = params;
  if (node.additionalProperties === undefined) walk.changes.push(`${path}: additionalProperties forced to false`);
  else if (node.additionalProperties !== false) reject(path, 'open object (additionalProperties is not false)');
  const properties = isNode(node.properties) ? node.properties : {};
  const required = new Set(Array.isArray(node.required) ? node.required.filter((entry): entry is string => typeof entry === 'string') : []);
  for (const name of required) if (!(name in properties)) walk.changes.push(`${path}: required '${name}' is not a property; ignored`);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(properties)) {
    const propertyPath = `${path}.${name}`;
    if (!isNode(property)) reject(propertyPath, 'property schema must be an object');
    const { schema, isNullable } = convertValue({ node: property, path: propertyPath, depth: depth + 1, walk });
    if (isNullable) walk.changes.push(`${propertyPath}: nullable type made optional (null is sent as absent)`);
    else if (!required.has(name)) walk.changes.push(`${propertyPath}: optional, sent as null when absent`);
    shape[name] = isNullable || !required.has(name) ? schema.optional() : schema;
  }
  return z.object(shape).strict();
}

function convertValue(params: NodeParams): { schema: z.ZodType; isNullable: boolean } {
  const { node, path, depth } = params;
  if (depth > MAX_SCHEMA_DEPTH) reject(path, `nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
  const { type, isNullable } = typeOf(params);
  checkKeywords({ ...params, ...(type == null ? {} : { type }) });
  const literals = literalsOf(params);
  let schema: z.ZodType;
  if (literals != null) schema = literals;
  else if (type === 'object') schema = objectSchema(params);
  else if (type === 'array') schema = arraySchema(params);
  else if (type === 'string') schema = stringSchema(node);
  else if (type === 'number' || type === 'integer') schema = numberSchema({ ...params, isInteger: type === 'integer' });
  else if (type === 'boolean') schema = z.boolean();
  else return reject(path, 'no type, enum or const');
  if (typeof node.description === 'string' && node.description.trim() !== '') schema = schema.describe(sanitiseServerText({ text: node.description, maxChars: MAX_PROPERTY_DESCRIPTION_CHARS }));
  return { schema, isNullable };
}

/**
 * Converts an MCP tool's `inputSchema` into the strict subset: objects closed (`additionalProperties: false`),
 * optional properties sent as null, unsupported constructs (`oneOf`/`anyOf`/`allOf`, `$ref`, `patternProperties`,
 * open objects, type unions) rejected with the path and reason.
 */
export function schemaToStrict(schema: unknown): SchemaConversion {
  const walk: Walk = { changes: [] };
  try {
    if (!isNode(schema) || schema.type !== 'object') reject('args', `the root must be an object schema, got ${isNode(schema) ? `'${String(schema.type)}'` : String(schema)}`);
    checkKeywords({ node: schema, path: 'args', depth: 0, walk, type: 'object' });
    const args = objectSchema({ node: schema, path: 'args', depth: 0, walk });
    return { kind: 'strict', args, changes: walk.changes };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'rejected' in error) return { kind: 'rejected', reason: (error as Rejection).rejected };
    throw error;
  }
}
