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

/**
 * The cues the reader recognises, by what they select. Every cue must be used by at least one tuning wording (checked
 * by `catalogue.tests.ts`): a cue only a held-out wording uses would mean the reader was fitted to the held-out set.
 */
export const PROMPT_CUES = {
  bugs: [/\bbugs?\b/i, /defect/i],
  gdpr: [/gdpr/i],
  endpoints: [/endpoint/i, /\burls\b/i, /api surface/i],
  theme: [/theme/i, /stylesheet/i],
  'ui-customer': [/customer/i, /screens show/i],
  'pii-fields': [/\bpii\b/i, /personal[- ]data/i],
  'dead-exports': [/unused/i, /dead export/i, /never used/i, /nothing calls/i],
  react: [/react/i],
  'tests-for': [/\btests?\b/i, /spec/i],
  symbol: [/defined/i, /declared/i, /definition/i, /who uses/i],
  'string-noisy': [/analytics/i],
  'string-any-case': [/any spelling/i, /however it is spelled/i, /ignoring capitals/i, /separator-insensitive/i],
  'string-word': [/exact word/i, /whole[- ]word/i],
} as const satisfies Record<string, readonly RegExp[]>;

/** Keyword rules for prompts that name no term, tried in order. */
const BARE_RULES: readonly Bare[] = ['bugs', 'gdpr', 'endpoints', 'theme', 'ui-customer', 'pii-fields', 'dead-exports', 'react'];

const METHOD = /^(GET|POST|PUT|PATCH|DELETE)\s+\//;

const cued = (params: { prompt: string; cue: keyof typeof PROMPT_CUES }): boolean => PROMPT_CUES[params.cue].some(pattern => pattern.test(params.prompt));

/** Reads the intent from the prompt alone; undefined when the prompt is not understood. */
export function readPrompt(prompt: string): Intent | undefined {
  const term = /`([^`]+)`/.exec(prompt)?.[1]?.replace(/\(\)$/, '');
  if (term == null) {
    const kind = BARE_RULES.find(cue => cued({ prompt, cue }));
    return kind == null ? undefined : { kind };
  }
  if (/\.(tsx?|jsx?)$/.test(term)) return cued({ prompt, cue: 'tests-for' }) ? { kind: 'tests-for', module: term } : { kind: 'find-file', name: term };
  if (/^[A-Z][A-Z0-9_]+$/.test(term)) return { kind: 'env-var', name: term };
  if (METHOD.test(term)) return { kind: 'route-trace', endpoint: term };
  if (cued({ prompt, cue: 'symbol' })) return { kind: 'symbol', name: term };
  if (cued({ prompt, cue: 'string-noisy' })) return { kind: 'string-noisy', verb: term };
  if (cued({ prompt, cue: 'string-any-case' })) return { kind: 'string-any-case', identifier: term };
  if (cued({ prompt, cue: 'string-word' })) return { kind: 'string-word', identifier: term };
  return { kind: 'string-usage', identifier: term };
}
