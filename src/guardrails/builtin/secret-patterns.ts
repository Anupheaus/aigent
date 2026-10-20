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
/** A key name, also inside an env-style name (`DB_PASSWORD`, `aws_secret_access_key`), never inside a word (`tokenizer`). */
const KEY_NAME = `(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:${KEY_NAMES})(?:[_-][A-Za-z0-9]+)*(?![A-Za-z0-9])`;
/** Names whose unquoted value is a password even without digits (`password=CorrectHorseBatteryStaple`). */
const PASSWORD_NAMES = 'pass(?:word|wd)?|pwd';
/** Groups of the key=value pattern: a double-quoted, single-quoted or unquoted value. */
const QUOTED_GROUPS = [1, 2];
const UNQUOTED_GROUP = 3;
/** The capture group holding a bearer token. */
const BEARER_GROUP = 1;

const PATTERNS: readonly SecretPattern[] = [
  // A key cut short (a length-limited answer) is redacted through to the end of the text.
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'api-key', pattern: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|\bwhsec_[A-Za-z0-9]{24,}/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'huggingface-token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'bearer-token', pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]{16,}=*)/g, groups: [BEARER_GROUP] },
  { kind: 'connection-string', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi },
  {
    kind: 'password', pattern: new RegExp(`${KEY_NAME}["']?\\s*[:=]\\s*(?:"([^"\\s]{6,})"|'([^'\\s]{6,})'|([^\\s"'\`,;()]{8,})(?![(\\w]))`, 'gi'), groups: [...QUOTED_GROUPS, UNQUOTED_GROUP],
    accept: (secret, group) => group !== UNQUOTED_GROUP || (!secret.includes('.') && /[A-Za-z]/.test(secret) && /\d/.test(secret)),
  },
  {
    // Password-named keys: an unquoted value of letters only is still a password.
    kind: 'password', pattern: new RegExp(`(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:${PASSWORD_NAMES})(?![A-Za-z0-9])\\s*[:=]\\s*([A-Za-z][A-Za-z!#$%&*+\\-?@^_~]{7,})(?![(\\w.])`, 'gi'), groups: [1],
  },
];

/** Invisible characters that would split a secret so no pattern matches it. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/;

/** `text` without zero-width characters, and where each kept character was in `text`. */
function visible(text: string): { text: string; positions: number[] } {
  const positions: number[] = [];
  let kept = '';
  for (let position = 0; position < text.length; position += 1) {
    const character = text.charAt(position);
    if (ZERO_WIDTH.test(character)) continue;
    positions.push(position);
    kept += character;
  }
  positions.push(text.length);
  return { text: kept, positions };
}

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

/** Every secret in `text`, in order, without overlaps (the earlier, then longer, match wins); zero-width characters are seen through. */
export function findSecrets(text: string): SecretSpan[] {
  const shown = ZERO_WIDTH.test(text) ? visible(text) : undefined;
  const scanned = shown?.text ?? text;
  const all = PATTERNS.flatMap(secret => spansOf({ text: scanned, secret })).sort((left, right) => left.matchStart - right.matchStart || right.matchEnd - left.matchEnd);
  const kept: SecretSpan[] = [];
  for (const span of all) if (kept.every(({ matchEnd }) => span.matchStart >= matchEnd)) kept.push(span);
  if (shown == null) return kept;
  // Back to positions in the original text (a span then covers the zero-width characters inside it too).
  const at = (position: number): number => shown.positions[position] ?? text.length;
  return kept.map(({ kind, start, end, matchStart, matchEnd }) => ({ kind, start: at(start), end: at(end - 1) + 1, matchStart: at(matchStart), matchEnd: at(matchEnd - 1) + 1 }));
}

/** Literal beginnings of secrets: a stream ending in part of one is held until the next text shows what it is. */
const LITERAL_PREFIXES: readonly string[] = [
  'sk-', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'whsec_', 'AKIA', 'ASIA', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'npm_', 'hf_',
  'xoxa-', 'xoxb-', 'xoxp-', 'xoxo-', 'xoxs-', 'xoxr-', 'AIza', 'eyJ', 'Bearer ', '-----BEGIN ', 'password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'api-key',
  'apikey', 'access_key', 'access-key', 'accesskey', 'client_secret',
];

/** The longest literal prefix: a hold-back shorter than this could release a secret's start before it is recognised. */
export const LONGEST_SECRET_PREFIX = Math.max(...LITERAL_PREFIXES.map(prefix => prefix.length));

/** Beginnings a secret may still grow from: held back in streams until they are complete or clearly not secrets. */
const OPEN_PREFIX = /(?:\bsk-|\b[sr]k_(?:live|test)_|\bwhsec_|\b(?:AKIA|ASIA)|\bgh[pousr]_|\bgithub_pat_|\bglpat-|\bnpm_|\bhf_|\bxox[abposr]-|\bAIza|\beyJ|\bBearer\s|\b[a-z][a-z0-9+.-]*:\/\/|\b[a-z][a-z0-9+.-]*:\/?$)[^\s]*$/i;
const OPEN_KEY_VALUE = new RegExp(`${KEY_NAME}["']?\\s*[:=]?\\s*["']?[^\\s"']*$`, 'i');
/** A header still arriving, or a private key's header with no end line yet. */
const OPEN_PRIVATE_KEY = /-----BEGIN [A-Z ]*-{0,4}$|-----BEGIN [A-Z ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z ]*PRIVATE KEY-----)/;

/** Where `text` ends in the first part of a literal prefix (e.g. `s` or `gh`), so the next chunk may complete it. */
function partialPrefixStart(text: string): number | undefined {
  const tail = text.slice(-LONGEST_SECRET_PREFIX).toLowerCase();
  let start: number | undefined;
  for (const prefix of LITERAL_PREFIXES) {
    for (let length = Math.min(prefix.length - 1, tail.length); length > 0; length -= 1) {
      if (!tail.endsWith(prefix.slice(0, length).toLowerCase())) continue;
      const at = text.length - length;
      start = start == null ? at : Math.min(start, at);
      break;
    }
  }
  return start;
}

/**
 * Where streamed `text` stops being safe to release: the start of a secret that may still be growing (a match that
 * reaches the end, a known secret prefix or the first part of one, a key name awaiting its value, an unterminated
 * private key); undefined when none.
 */
export function openSecretStart(text: string): number | undefined {
  const starts = [
    ...findSecrets(text).filter(({ matchEnd }) => matchEnd === text.length).map(({ matchStart }) => matchStart),
    OPEN_PREFIX.exec(text)?.index, OPEN_KEY_VALUE.exec(text)?.index, OPEN_PRIVATE_KEY.exec(text)?.index, partialPrefixStart(text),
  ].filter((start): start is number => start != null);
  return starts.length === 0 ? undefined : Math.min(...starts);
}
