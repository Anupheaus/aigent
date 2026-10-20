import { canonicalJson } from '../../core/canonical-json.js';
import type { Guardrail, LoopGuardOptions } from '../guardrail-types.js';

/** Identical calls allowed per run; the next one is blocked. */
export const DEFAULT_MAX_REPEATS = 3;
/** Longest final answer before it is truncated. */
export const DEFAULT_MAX_OUTPUT_CHARS = 200_000;

/** Blocks a call repeated with the same arguments too often in one run, and truncates a runaway answer. One per run. */
export function loopGuardrails(options: LoopGuardOptions): Guardrail[] {
  const { maxRepeats = DEFAULT_MAX_REPEATS, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS } = options;
  const counts = new Map<string, number>();
  return [
    {
      name: 'loop-guard', stage: 'toolCall',
      check: value => {
        if (typeof value !== 'object' || !('args' in value)) return { action: 'allow' };
        const key = `${value.tool}\u0000${canonicalJson(value.args)}`;
        const seen = counts.get(key) ?? 0;
        if (seen >= maxRepeats) {
          return { action: 'block', code: 'repeated_call', reason: `Tool '${value.tool}' was already called ${seen} times with these arguments in this run; the result will not change. Use the earlier results, change the arguments, or answer.` };
        }
        counts.set(key, seen + 1);
        return { action: 'allow' };
      },
    },
    {
      name: 'loop-guard', stage: 'output',
      check: value => {
        if (typeof value !== 'string' || value.length <= maxOutputChars) return { action: 'allow' };
        return { action: 'rewrite', value: `${value.slice(0, maxOutputChars)}\n[answer truncated at ${maxOutputChars} characters]`, note: `the answer was ${value.length} characters, over maxOutputChars ${maxOutputChars}` };
      },
    },
  ];
}
