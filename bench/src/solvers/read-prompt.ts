/** What a prompt asks for, as a model would understand it (the scripted policies' reading of the prompt). */
export type Intent =
  | { kind: 'find-file'; name: string }
  | { kind: 'tests-for'; module: string }
  | { kind: 'env-var'; name: string }
  | { kind: 'route-trace'; endpoint: string }
  | { kind: 'symbol'; name: string }
  | { kind: 'string-noisy'; verb: string }
  | { kind: 'string-any-case'; identifier: string }
  | { kind: 'string-word'; identifier: string }
  | { kind: 'string-usage'; identifier: string }
  | { kind: Bare };

/** Intents that need no term from the prompt. */
type Bare = 'bugs' | 'gdpr' | 'endpoints' | 'theme' | 'ui-customer' | 'pii-fields' | 'dead-exports' | 'react';

/** Keyword rules for prompts that name no term, tried in order. */
const BARE_RULES: readonly [Bare, RegExp][] = [
  ['bugs', /\bbugs?\b|defect/i],
  ['gdpr', /gdpr/i],
  ['endpoints', /endpoint|\burls\b|method and path|api surface/i],
  ['theme', /theme|stylesheet/i],
  ['ui-customer', /customer|screens show/i],
  ['pii-fields', /\bpii\b|personal[- ]data/i],
  ['dead-exports', /unused|dead export|never used|nothing (calls|else references)/i],
  ['react', /react/i],
];

const METHOD = /^(GET|POST|PUT|PATCH|DELETE)\s+\//;

/** Reads the intent from the prompt alone; undefined when the prompt is not understood. */
export function readPrompt(prompt: string): Intent | undefined {
  const term = /`([^`]+)`/.exec(prompt)?.[1]?.replace(/\(\)$/, '');
  if (term == null) {
    const kind = BARE_RULES.find(([, pattern]) => pattern.test(prompt))?.[0];
    return kind == null ? undefined : { kind };
  }
  if (/\.(tsx?|jsx?)$/.test(term)) return /\btests?\b|spec/i.test(prompt) ? { kind: 'tests-for', module: term } : { kind: 'find-file', name: term };
  if (/^[A-Z][A-Z0-9_]+$/.test(term)) return { kind: 'env-var', name: term };
  if (METHOD.test(term)) return { kind: 'route-trace', endpoint: term };
  if (/defined|declared|definition|who uses/i.test(prompt)) return { kind: 'symbol', name: term };
  if (/analytics/i.test(prompt)) return { kind: 'string-noisy', verb: term };
  if (/any spelling|however it is spelled|ignoring capitals|separator-insensitive|any casing/i.test(prompt)) return { kind: 'string-any-case', identifier: term };
  if (/exact word|whole[- ]word/i.test(prompt)) return { kind: 'string-word', identifier: term };
  return { kind: 'string-usage', identifier: term };
}
