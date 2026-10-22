import { neutraliseInstructions } from '../guardrails/builtin/injection.js';

/** Longest tool description the model sees. */
export const MAX_DESCRIPTION_CHARS = 1_000;
/** Longest argument (property) description the model sees. */
export const MAX_PROPERTY_DESCRIPTION_CHARS = 300;
const ELLIPSIS = '…';

/**
 * C0/C1 control characters (except tab and newline), and invisible formatting characters that can hide text from a
 * reviewer: zero-width spaces and joiners, bidirectional overrides and isolates, the BOM.
 */
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Untrusted text from an MCP server made safe to show the model: hidden characters stripped, directive markers and
 * instruction-override phrases neutralised, whitespace trimmed, and cut to `maxChars` (with an ellipsis).
 */
export function sanitiseServerText(params: { text: string; maxChars: number }): string {
  const { text, maxChars } = params;
  const cleaned = neutraliseInstructions(text.replace(/\r\n?/g, '\n').replace(HIDDEN_CHARACTERS, '')).trim();
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - ELLIPSIS.length)}${ELLIPSIS}`;
}
