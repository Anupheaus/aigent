import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';
import type { JsonSchema } from '../providers/provider-types.js';
import type { Tool } from '../tools/tool-types.js';

const HASH_ALGORITHM = 'sha256';

export interface ComputeCacheKeyParams {
  tool: Tool;
  /** Validated arguments; feedback fields are already stripped and aliases expanded at this point. */
  args: unknown;
  /** The tool's validity token for these arguments, when it defines one. */
  validity?: string;
}

function sha256Hex(text: string): string {
  return createHash(HASH_ALGORITHM).update(text).digest('hex');
}

/** Hash of an argument schema; `defineTool` stores it as `Tool.schemaHash` so wrappers that extend the schema keep it. */
export function hashSchema(jsonSchema: JsonSchema): string {
  return sha256Hex(canonicalJson(jsonSchema));
}

/**
 * Lowercase hex sha-256 of the canonical JSON of the tool name, version, schema hash, normalised arguments and validity
 * token. Key order never matters; a new tool version or argument schema never collides with an older one.
 */
export function computeCacheKey(params: ComputeCacheKeyParams): string {
  const { tool, args, validity } = params;
  const { name, version, schemaHash = hashSchema(tool.jsonSchema), cacheKey } = tool;
  const key = cacheKey == null ? args : cacheKey(args);
  return sha256Hex(canonicalJson({ name, version, schemaHash, key, validity }));
}
