import type { z } from 'zod';
import { hashSchema } from '../cache/cache-key.js';
import { toLooseJsonSchema } from './loose-schema.js';
import { toStrictJsonSchema } from './strict-schema.js';
import type { ToolInput } from './tool-input.js';
import type { DescribeActivity, Tool, ToolContext } from './tool-types.js';
import { validateBase } from './validate-tool-input.js';

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFINITION_ID_PREFIX = 'tooldef-';

/** Counts definitions made in this process, for `Tool.definitionId`. */
let definitionCount = 0;

export function defineTool<TSchema extends z.ZodType>(input: ToolInput<TSchema>): Tool {
  validateBase(input);
  const { name, description, args, deterministic, cache, cacheTtlMs, version, cacheNamespace, sharedCache, cacheKey, validity, contentKind, fidelity, hasSideEffects = false, acceptsAliases, compactable, compressible, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, maxResultTokens, strictSchema = true, describeActivity, run, resume, verify, requiresApproval, risk, dryRun, undo, applyUndo, promptAddendum } = input;
  const jsonSchema = strictSchema ? toStrictJsonSchema(args) : toLooseJsonSchema(args);
  return {
    name,
    description,
    argsSchema: args,
    jsonSchema,
    schemaHash: hashSchema(jsonSchema),
    strict: strictSchema,
    deterministic,
    cache,
    cacheTtlMs,
    ...(version == null ? {} : { version }),
    ...(cacheNamespace == null ? {} : { cacheNamespace }),
    ...(sharedCache === true ? { sharedCache } : {}),
    definitionId: `${DEFINITION_ID_PREFIX}${(definitionCount += 1)}`,
    ...(contentKind == null ? {} : { contentKind }),
    ...(fidelity == null ? {} : { fidelity }),
    ...(cacheKey == null ? {} : { cacheKey: (cacheArgs: unknown) => cacheKey(cacheArgs as z.infer<TSchema>) }),
    ...(validity == null ? {} : { validity: (validityArgs: unknown, context: ToolContext) => validity(validityArgs as z.infer<TSchema>, context) }),
    hasSideEffects,
    ...(acceptsAliases === true ? { acceptsAliases } : {}),
    ...(compactable === false ? { compactable } : {}),
    ...(compressible == null || compressible === false ? {} : { compressible }),
    ...(resume == null ? {} : { resume }),
    ...(requiresApproval == null || requiresApproval === false ? {} : { requiresApproval }),
    ...(risk == null ? {} : { risk }),
    ...(promptAddendum == null ? {} : { promptAddendum }),
    ...(verify == null ? {} : { verify: (verifyArgs: unknown, context: ToolContext) => verify(verifyArgs as z.infer<TSchema>, context) }),
    ...(dryRun == null ? {} : { dryRun: (dryArgs: unknown, context: ToolContext) => dryRun(dryArgs as z.infer<TSchema>, context) }),
    ...(undo == null ? {} : { undo: (undoArgs: unknown, result: unknown, context: ToolContext) => undo(undoArgs as z.infer<TSchema>, result, context) }),
    ...(applyUndo == null ? {} : { applyUndo }),
    timeoutMs,
    maxResultTokens,
    describeActivity: describeActivity as DescribeActivity<unknown>,
    run: (parsedArgs, context) => run(parsedArgs as z.infer<TSchema>, context),
  };
}
