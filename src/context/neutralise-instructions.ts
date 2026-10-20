/** What an instruction-override phrase in untrusted text becomes. */
export const REMOVED_INSTRUCTION = '[instruction-like text removed]';
/** What the `::aigent` marker of a directive line in untrusted text becomes, so it can never be read as a directive. */
export const REMOVED_DIRECTIVE = '[directive marker removed]';

/**
 * Phrases that try to replace the agent's instructions. A local stand-in until the guardrails slice brings real
 * injection detection: it catches the common forms, not every paraphrase, so the text around it is still labelled as data.
 */
const OVERRIDE_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)*(?:previous|prior|above|earlier|preceding|system|original)?\s*(?:instructions|rules|prompts?|directions|guidelines|system prompt)\b/gi,
  /\b(?:disregard|ignore)\s+(?:all\s+|the\s+)*(?:above|previous|prior)\b/gi,
  /\byou are now\b/gi,
  /\bnew instructions\s*:/gi,
  /\breveal\s+(?:the\s+|your\s+)?system prompt\b/gi,
];

/** `::aigent` at the start of a line (after any indentation). */
const DIRECTIVE_MARKER = /^(\s*)::aigent\b/gm;

/**
 * Untrusted text (tool output, or a summary written from it) with directive lines defused and instruction-override
 * phrases replaced, so carrying it forward in the prompt cannot smuggle in new instructions.
 */
export function neutraliseInstructions(text: string): string {
  const withoutDirectives = text.replace(DIRECTIVE_MARKER, `$1${REMOVED_DIRECTIVE}`);
  return OVERRIDE_PATTERNS.reduce((current, pattern) => current.replace(pattern, REMOVED_INSTRUCTION), withoutDirectives);
}
