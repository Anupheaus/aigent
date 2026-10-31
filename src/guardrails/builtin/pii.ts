import type { Guardrail, GuardrailDecision, GuardrailStage, GuardrailValue, PiiMode, PiiOptions } from '../guardrail-types.js';
import { mapStrings, stringsOf } from '../map-strings.js';

/** Personal data found in text. */
export interface PiiSpan {
  kind: 'email' | 'phone' | 'card' | 'iban';
  start: number;
  end: number;
}

const CARD_MIN_DIGITS = 13;
const IBAN_MODULUS = 97n;
const LETTER_OFFSET = 55;

/** The Luhn checksum every payment card number passes. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  [...digits].reverse().forEach((digit, index) => {
    const value = Number(digit) * (index % 2 === 1 ? 2 : 1);
    sum += value > 9 ? value - 9 : value;
  });
  return sum % 10 === 0;
}

/** The ISO 13616 mod-97 check every IBAN passes. */
function passesIban(text: string): boolean {
  const compact = text.replace(/\s/g, '').toUpperCase();
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = [...rearranged].map(character => (/[A-Z]/.test(character) ? String(character.charCodeAt(0) - LETTER_OFFSET) : character)).join('');
  return BigInt(numeric) % IBAN_MODULUS === 1n;
}

const PATTERNS: readonly { kind: PiiSpan['kind']; pattern: RegExp; accept?(match: string): boolean }[] = [
  { kind: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'iban', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, accept: passesIban },
  // Card networks issue numbers starting 2 to 6, which also keeps runs of zeros (which pass Luhn) out.
  { kind: 'card', pattern: /\b[2-6](?:[ -]?\d){12,18}\b/g, accept: match => { const digits = match.replace(/\D/g, ''); return digits.length >= CARD_MIN_DIGITS && passesLuhn(digits); } },
  { kind: 'phone', pattern: /(?:\+\d{1,3}[ -]?\d{1,4}(?:[ -]\d{2,4}){2,3}|\(\d{3}\) ?\d{3}-\d{4})\b/g },
];

/** Emails, phone numbers, card numbers (Luhn) and IBANs (mod 97) in `text`, without overlaps. */
export function findPii(text: string): PiiSpan[] {
  const all = PATTERNS.flatMap(({ kind, pattern, accept }) => [...text.matchAll(pattern)].flatMap(match => (accept?.(match[0]) === false ? [] : [{ kind, start: match.index, end: match.index + match[0].length }])));
  const kept: PiiSpan[] = [];
  for (const span of all.sort((left, right) => left.start - right.start || right.end - left.end)) if (kept.every(({ end }) => span.start >= end)) kept.push(span);
  return kept;
}

function redactPii(text: string, kinds: Set<string>): string {
  let redacted = '';
  let cursor = 0;
  for (const { kind, start, end } of findPii(text)) {
    kinds.add(kind);
    redacted += `${text.slice(cursor, start)}[REDACTED:${kind}]`;
    cursor = end;
  }
  return redacted + text.slice(cursor);
}

/** `text` with each piece of personal data replaced by `[REDACTED:<kind>]`. */
export function redactPersonalData(text: string): string {
  return redactPii(text, new Set());
}

/** Whether the pii options redact at some stage (output or tool results): text kept for later runs is then redacted too. */
export function redactsPersonalData(options: PiiOptions | false | undefined): boolean {
  if (options == null || options === false) return false;
  return options.output === 'redact' || options.toolResult === 'redact';
}

function checkFor(params: { stage: GuardrailStage; mode: PiiMode }): Guardrail['check'] {
  const { stage, mode } = params;
  return (value: GuardrailValue, { warn }): GuardrailDecision => {
    const isText = typeof value === 'string';
    const content = isText ? value : 'result' in value ? value.result : undefined;
    if (mode === 'warn') {
      const kinds = [...new Set(stringsOf(content).flatMap(text => findPii(text).map(({ kind }) => kind)))];
      if (kinds.length > 0) warn(`personal data in the ${stage === 'output' ? 'output' : 'tool result'}: ${kinds.join(', ')}`);
      return { action: 'allow' };
    }
    const kinds = new Set<string>();
    const redacted = mapStrings({ value: content, change: text => redactPii(text, kinds) });
    if (kinds.size === 0) return { action: 'allow' };
    return { action: 'rewrite', value: isText ? redacted : { ...value, result: redacted }, note: `redacted personal data: ${[...kinds].join(', ')}` };
  };
}

/**
 * PII per stage: `warn` (output default), `redact`, or `off` (tool results default). Redacted output is redacted in
 * the stream too, so the streamed text never shows what the answer hides.
 */
export function piiGuardrails(options: PiiOptions): Guardrail[] {
  const output = options.output ?? 'warn';
  const modes: [GuardrailStage, PiiMode][] = [['output', output], ['toolResult', options.toolResult ?? 'off'], ['stream', output === 'redact' ? 'redact' : 'off']];
  return modes.filter(([, mode]) => mode !== 'off').map(([stage, mode]) => ({ name: 'pii', stage, check: checkFor({ stage, mode }) }));
}
