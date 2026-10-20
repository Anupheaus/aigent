import { createHash } from 'node:crypto';
import { createAigentError } from '../core/aigent-error.js';
import { canonicalJson } from '../core/canonical-json.js';
import type { JsonSchema } from '../providers/provider-types.js';
import type { Tool } from '../tools/tool-types.js';

const HASH_ALGORITHM = 'sha256';
/** `typeof` results JSON represents as themselves (undefined object values are dropped). */
const PLAIN_PRIMITIVE_TYPES: readonly string[] = ['string', 'number', 'boolean', 'undefined'];

export interface ComputeCacheKeyParams {
  tool: Tool;
  /** Validated arguments; feedback fields are already stripped and aliases expanded at this point. */
  args: unknown;
  /**
   * True for instance-scoped (non-deterministic) entries: the tool's per-definition identity joins the key, so two
   * definitions that share a name, schema and description (bound to different data) never share results.
   */
  isDefinitionScoped?: boolean;
}

function sha256Hex(text: string): string {
  return createHash(HASH_ALGORITHM).update(text).digest('hex');
}

/** Plain JSON data only: anything else (Date, Map, Set, class instances) would serialise as `{}` and make keys collide. */
function assertPlainData(value: unknown, path: string): void {
  if (value === null || PLAIN_PRIMITIVE_TYPES.includes(typeof value)) return;
  if (Array.isArray(value)) { value.forEach((entry, index) => assertPlainData(entry, `${path}[${index}]`)); return; }
  const prototype: unknown = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw createAigentError({ code: 'invalid_input', message: `Cache key value at ${path} is not plain JSON data (got ${Object.prototype.toString.call(value)}); return strings, numbers, arrays or plain objects from cacheKey`, details: { path } });
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) assertPlainData(entry, `${path}.${key}`);
}

/** Hash of an argument schema; `defineTool` stores it as `Tool.schemaHash` so wrappers that extend the schema keep it. */
export function hashSchema(jsonSchema: JsonSchema): string {
  return sha256Hex(canonicalJson(jsonSchema));
}

/**
 * Lowercase hex sha-256 of the canonical JSON of the tool name, version, schema hash, description, normalised arguments
 * and (when definition scoped) the tool's definition id. Key order never matters; a new tool version, argument schema or
 * description never collides with an older one. The validity token is not part of the key: it is kept on the entry,
 * so a changed token finds (and replaces) the stale entry instead of leaving it behind under an orphaned key.
 */
export function computeCacheKey(params: ComputeCacheKeyParams): string {
  const { tool, args, isDefinitionScoped = false } = params;
  const { name, version, description, schemaHash = hashSchema(tool.jsonSchema), cacheKey, definitionId } = tool;
  const key = cacheKey == null ? args : cacheKey(args);
  // Throwing makes the lookup fail, so the call runs uncached instead of colliding with unrelated calls.
  assertPlainData(key, 'key');
  return sha256Hex(canonicalJson({ name, version, schemaHash, description, key, definition: isDefinitionScoped ? definitionId ?? '' : undefined }));
}
