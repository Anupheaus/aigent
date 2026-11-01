import { createAigentError } from '../core/aigent-error.js';
import { CONTENT_KINDS, FIDELITIES } from '../shapers/shaper-types.js';
import type { ToolBaseInput } from './tool-input.js';
import { validateApprovalFields, validateEffectFields, validateResumeFields } from './tool-policies.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The cache fields every tool input may carry, checked without their argument types. */
interface CacheFieldsInput {
  cacheKey?: unknown;
  validity?: unknown;
}

export function invalid(toolName: string, message: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `Tool '${toolName}': ${message}`, details: { tool: toolName } });
}

function validateCacheFields(input: ToolBaseInput & CacheFieldsInput): void {
  const { name, cache, deterministic, version, cacheKey, validity, cacheNamespace, sharedCache } = input;
  if (version !== undefined && (typeof version !== 'string' || version === '')) invalid(name, `version must be a non-empty string, got ${JSON.stringify(version)}`);
  if (cacheKey !== undefined && typeof cacheKey !== 'function') invalid(name, 'cacheKey must be a function of the arguments');
  if (validity !== undefined && typeof validity !== 'function') invalid(name, 'validity must be a function returning a promise of a token');
  if (!cache && (cacheKey !== undefined || validity !== undefined)) invalid(name, 'cacheKey and validity only apply to cached tools (cache: true)');
  if (cacheNamespace !== undefined && (typeof cacheNamespace !== 'string' || cacheNamespace === '')) invalid(name, `cacheNamespace must be a non-empty string, got ${JSON.stringify(cacheNamespace)}`);
  if (sharedCache !== undefined && typeof sharedCache !== 'boolean') invalid(name, `sharedCache must be a boolean, got ${String(sharedCache)}`);
  if ((cacheNamespace !== undefined || sharedCache !== undefined) && !(cache && deterministic)) {
    invalid(name, 'cacheNamespace and sharedCache only apply to deterministic cached tools (deterministic: true, cache: true); other cached results stay private to their instance');
  }
}

function validateShapingFields(input: ToolBaseInput): void {
  const { name, contentKind, fidelity } = input;
  if (contentKind !== undefined && !(CONTENT_KINDS as readonly unknown[]).includes(contentKind)) invalid(name, `contentKind must be one of ${CONTENT_KINDS.join(', ')}, got ${String(contentKind)}`);
  if (fidelity !== undefined && !(FIDELITIES as readonly unknown[]).includes(fidelity)) invalid(name, `fidelity must be one of ${FIDELITIES.join(', ')}, got ${String(fidelity)}`);
  if (fidelity === 'lossy-ok' && contentKind === undefined) invalid(name, "fidelity 'lossy-ok' needs a contentKind, so only shapers declared for that kind can run");
}

/** Checks a tool definition, throwing `invalid_definition` naming the tool and the field. */
export function validateBase(input: ToolBaseInput & CacheFieldsInput & { describeActivity: unknown; dryRun?: unknown; undo?: unknown; applyUndo?: unknown }): void {
  const { name, deterministic, cache, cacheTtlMs, hasSideEffects, acceptsAliases, timeoutMs, describeActivity } = input;
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) invalid(String(name), `name must match ${TOOL_NAME_PATTERN} (lowercase snake_case), got '${String(name)}'`);
  if (typeof deterministic !== 'boolean') invalid(name, 'deterministic must be declared explicitly (true or false)');
  if (typeof cache !== 'boolean') invalid(name, 'cache must be declared explicitly (true or false)');
  if (typeof describeActivity !== 'function') invalid(name, 'describeActivity is required so the UI can render each call');
  if (hasSideEffects === true && (cache || deterministic)) invalid(name, 'a tool with side effects cannot be cached or deterministic');
  if (cache && !deterministic && (cacheTtlMs == null || cacheTtlMs <= 0)) invalid(name, 'a cached non-deterministic tool needs a positive cacheTtlMs');
  if (acceptsAliases !== undefined && typeof acceptsAliases !== 'boolean') invalid(name, `acceptsAliases must be a boolean, got ${String(acceptsAliases)}`);
  if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) invalid(name, `timeoutMs must be a positive integer number of milliseconds, got ${String(timeoutMs)}`);
  validateContextFields(input);
  validateResumeFields(input);
  validateApprovalFields(input);
  validateEffectFields(input);
  validateCacheFields(input);
  validateShapingFields(input);
}

function validateContextFields(input: ToolBaseInput): void {
  const { name, compactable, compressible, promptAddendum } = input;
  if (promptAddendum !== undefined && (typeof promptAddendum !== 'string' || promptAddendum.trim() === '')) invalid(name, 'promptAddendum must be non-empty text');
  if (compactable !== undefined && typeof compactable !== 'boolean') invalid(name, `compactable must be a boolean, got ${String(compactable)}`);
  if (compressible !== undefined && typeof compressible !== 'boolean' && compressible !== 'allow-code') invalid(name, `compressible must be true, false or 'allow-code', got ${String(compressible)}`);
}

export function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
