import type { Guardrail, GuardrailDecision, GuardrailValue, ToolResultValue } from '../guardrail-types.js';
import { mapStrings } from '../map-strings.js';
import { findSecrets } from './secret-patterns.js';

/** `text` with each secret replaced by `[REDACTED:<kind>]`, and the kinds found (each once, in order). */
export function redactSecrets(text: string): { text: string; kinds: string[] } {
  const spans = findSecrets(text);
  let redacted = '';
  let cursor = 0;
  for (const { kind, start, end } of spans) {
    redacted += `${text.slice(cursor, start)}[REDACTED:${kind}]`;
    cursor = end;
  }
  return { text: redacted + text.slice(cursor), kinds: [...new Set(spans.map(({ kind }) => kind))] };
}

function rewriteText(text: string): GuardrailDecision {
  const { text: redacted, kinds } = redactSecrets(text);
  return kinds.length === 0 ? { action: 'allow' } : { action: 'rewrite', value: redacted, note: `redacted secrets: ${kinds.join(', ')}` };
}

function rewriteResult(value: ToolResultValue): GuardrailDecision {
  const kinds = new Set<string>();
  const result = mapStrings({ value: value.result, change: text => { const redacted = redactSecrets(text); redacted.kinds.forEach(kind => kinds.add(kind)); return redacted.text; } });
  return kinds.size === 0 ? { action: 'allow' } : { action: 'rewrite', value: { ...value, result }, note: `redacted secrets: ${[...kinds].join(', ')}` };
}

const NAME = 'secrets';

/** Redacts API keys, tokens, private keys, credentials in connection strings and key=value secrets. */
export function secretGuardrails(): Guardrail[] {
  const text = (value: GuardrailValue): GuardrailDecision => (typeof value === 'string' ? rewriteText(value) : { action: 'allow' });
  return [
    { name: NAME, stage: 'output', check: text },
    { name: NAME, stage: 'stream', check: text },
    { name: NAME, stage: 'toolResult', check: value => (typeof value === 'object' && 'result' in value ? rewriteResult(value) : { action: 'allow' }) },
  ];
}
