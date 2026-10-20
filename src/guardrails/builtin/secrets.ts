import type { Guardrail, GuardrailDecision, GuardrailValue, ToolResultValue } from '../guardrail-types.js';
import { mapStrings } from '../map-strings.js';

/** One kind of secret: its pattern, and which capture group holds the secret itself (default: the whole match). */
interface SecretPattern {
  kind: string;
  pattern: RegExp;
  /** Capture groups (any one matching) that hold the secret; the rest of the match is kept. */
  groups?: number[];
  /** Rejects look-alikes (e.g. code such as `token = getToken()`). */
  accept?(secret: string, group: number): boolean;
}

/** A secret found in text: the span redacted, inside the span of the whole match. */
export interface SecretSpan {
  kind: string;
  start: number;
  end: number;
  matchStart: number;
  matchEnd: number;
}

const KEY_NAMES = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret';
/** The group of an unquoted value, which must look like a credential (letters and digits, no dots or calls). */
const UNQUOTED_GROUP = 3;

const PATTERNS: readonly SecretPattern[] = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'api-key', pattern: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'connection-string', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi },
  {
    kind: 'password', pattern: new RegExp(`\\b(?:${KEY_NAMES})\\b["']?\\s*[:=]\\s*(?:"([^"\\s]{8,})"|'([^'\\s]{8,})'|([^\\s"'\`,;()]{8,}))`, 'gi'), groups: [1, 2, UNQUOTED_GROUP],
    accept: (secret, group) => group !== UNQUOTED_GROUP || (/\d/.test(secret) && /[A-Za-z]/.test(secret) && !secret.includes('.')),
  },
];

function spansOf(params: { text: string; secret: SecretPattern }): SecretSpan[] {
  const { text, secret: { kind, pattern, groups, accept } } = params;
  const flags = pattern.flags.includes('d') ? pattern.flags : `${pattern.flags}d`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].flatMap(match => {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (groups == null) return [{ kind, start: matchStart, end: matchEnd, matchStart, matchEnd }];
    const group = groups.find(index => match[index] != null);
    const indices = group == null ? undefined : match.indices?.[group];
    if (group == null || indices == null || accept?.(match[group] ?? '', group) === false) return [];
    return [{ kind, start: indices[0], end: indices[1], matchStart, matchEnd }];
  });
}

/** Every secret in `text`, in order, without overlaps (the earlier, then longer, match wins). */
export function findSecrets(text: string): SecretSpan[] {
  const all = PATTERNS.flatMap(secret => spansOf({ text, secret })).sort((left, right) => left.matchStart - right.matchStart || right.matchEnd - left.matchEnd);
  const kept: SecretSpan[] = [];
  for (const span of all) if (kept.every(({ matchEnd }) => span.matchStart >= matchEnd)) kept.push(span);
  return kept;
}

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

/** Beginnings a secret may still grow from: held back in streams until they are complete or clearly not secrets. */
const OPEN_PREFIX = /(?:\bsk-|\b(?:AKIA|ASIA)|\bgh[pousr]_|\bgithub_pat_|\bxox[abposr]-|\bAIza|\beyJ|\b[a-z][a-z0-9+.-]*:\/\/)[^\s]*$/i;
const OPEN_KEY_VALUE = new RegExp(`\\b(?:${KEY_NAMES})\\b["']?\\s*[:=]?\\s*["']?[^\\s"']*$`, 'i');
const OPEN_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z ]*PRIVATE KEY-----)/;

/**
 * Where streamed `text` stops being safe to release: the start of a secret that may still be growing (a match that
 * reaches the end, a known secret prefix, a key name awaiting its value, an unterminated private key); undefined when none.
 */
export function openSecretStart(text: string): number | undefined {
  const starts = [
    ...findSecrets(text).filter(({ matchEnd }) => matchEnd === text.length).map(({ matchStart }) => matchStart),
    OPEN_PREFIX.exec(text)?.index, OPEN_KEY_VALUE.exec(text)?.index, OPEN_PRIVATE_KEY.exec(text)?.index,
  ].filter((start): start is number => start != null);
  return starts.length === 0 ? undefined : Math.min(...starts);
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
