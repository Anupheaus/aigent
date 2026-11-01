import { findInjection } from '../guardrails/builtin/injection.js';
import { scrubMemoryText } from '../memory/scrub-memory-text.js';

/** What checking one learned text found. */
export interface LearnedTextCheck {
  /** The text with secrets (and personal data, when asked) replaced by `[REDACTED:<kind>]`. */
  text: string;
  /** Kinds of instruction-like content found (override phrases, directives, role markers...); empty when none. */
  injection: string[];
}

/**
 * Learned content (strategy rules, skill descriptions, lessons) is untrusted data that outlives its run and reaches
 * later prompts, so it is checked before it is stored and again before it is shown: secrets are always redacted,
 * personal data when the runtime's pii guardrail redacts, and instruction-like text is reported for the caller to refuse.
 */
export function checkLearnedText(params: { text: string; redactsPii?: boolean }): LearnedTextCheck {
  const { text, redactsPii = false } = params;
  return { text: scrubMemoryText({ text, redactsPii }), injection: findInjection(text) };
}

/** Whether a stored text is still safe to show as it is: no secret or personal data left and nothing instruction-like. */
export function isSafeToShow(params: { text: string; redactsPii?: boolean }): boolean {
  const { text, injection } = checkLearnedText(params);
  return injection.length === 0 && text === params.text;
}
