import { createAigentError } from '../../../core/aigent-error.js';
import { stripExtendedSyntax } from '../../../security/regex-extended.js';
import { runRegexJob } from '../regex-pool.js';

/** Whether a text matches one of the filter's `$regex` conditions (answers come from `prepareRegexTest`). */
export type RegexTest = (params: { pattern: string; options: string; text: string }) => boolean;

interface RegexCondition {
  pattern: string;
  options: string;
}

/** Flags MongoDB's `$options` and JavaScript share; `x` is applied by rewriting the pattern instead. */
const SHARED_FLAGS = /[ims]/g;
const KEY_SEPARATOR = '\u0000';

function keyOf(params: RegexCondition): string {
  const { pattern, options } = params;
  return `${options}${KEY_SEPARATOR}${pattern}`;
}

/** Every `$regex` condition anywhere in the filter (under fields, `$not`, `$elemMatch` and logical operators). */
function collectConditions(params: { value: unknown; found: Map<string, RegexCondition> }): void {
  const { value, found } = params;
  if (Array.isArray(value)) { for (const element of value) collectConditions({ value: element, found }); return; }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.$regex === 'string') {
    const condition = { pattern: record.$regex, options: typeof record.$options === 'string' ? record.$options : '' };
    found.set(keyOf(condition), condition);
  }
  for (const child of Object.values(record)) collectConditions({ value: child, found });
}

/** Every distinct text anywhere in the documents: the only values a `$regex` can match. */
function collectTexts(params: { value: unknown; found: Set<string> }): void {
  const { value, found } = params;
  if (typeof value === 'string') { found.add(value); return; }
  if (typeof value !== 'object' || value === null) return;
  for (const child of Object.values(value)) collectTexts({ value: child, found });
}

/** The pattern and JavaScript flags MongoDB's options mean (`x` drops whitespace and comments). */
function engineRegex(condition: RegexCondition): { pattern: string; flags: string } {
  const { pattern, options } = condition;
  const flags = [...new Set(options.match(SHARED_FLAGS) ?? [])].join('');
  return { pattern: options.includes('x') ? stripExtendedSyntax(pattern) : pattern, flags: `${flags}g` };
}

/**
 * Runs every `$regex` in the filter against every text in the documents in a worker thread, under `maxTimeMs` for
 * all of them together, so a catastrophic pattern never blocks the event loop (as `maxTimeMS` bounds it on a
 * server). Returns the lookup the in-memory filter then evaluates synchronously.
 */
export async function prepareRegexTest(params: { filter: Record<string, unknown>; docs: readonly Record<string, unknown>[]; maxTimeMs: number; signal: AbortSignal }): Promise<RegexTest> {
  const { filter, docs, maxTimeMs, signal } = params;
  const conditions = new Map<string, RegexCondition>();
  collectConditions({ value: filter, found: conditions });
  const matched = new Map<string, Set<string>>();
  if (conditions.size === 0) return () => false;
  const textSet = new Set<string>();
  collectTexts({ value: docs, found: textSet });
  const texts = [...textSet];
  const deadline = Date.now() + maxTimeMs;
  for (const [key, condition] of conditions) {
    const { pattern, flags } = engineRegex(condition);
    const outcome = await runRegexJob({ job: { pattern, flags, texts, keep: texts.length, countAll: false, firstPerText: true }, deadline, signal });
    if (outcome.status === 'aborted') throw createAigentError({ code: 'aborted', message: `The in-memory $regex '${condition.pattern}' was stopped because the run was stopped`, details: { pattern: condition.pattern } });
    if (outcome.status === 'timed-out') throw createAigentError({ code: 'provider_failed', message: `The in-memory $regex '${condition.pattern}' did not finish within maxTimeMs (${maxTimeMs} ms)`, details: { pattern: condition.pattern, maxTimeMs } });
    if (outcome.status === 'failed') throw createAigentError({ code: 'invalid_input', message: `The in-memory $regex '${condition.pattern}' failed: ${outcome.message}`, details: { pattern: condition.pattern } });
    matched.set(key, new Set(outcome.matches.map(({ text }) => texts[text] as string)));
  }
  return ({ pattern, options, text }) => matched.get(keyOf({ pattern, options }))?.has(text) === true;
}
