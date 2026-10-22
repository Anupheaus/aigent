import type { Manifest, RepoSize } from '../generate/repo-types.js';
import type { Acceptance, TrapSetup, TruthQuery } from '../task-spec.js';
import { HELD_OUT_VARIANT, VARIANT_IDS } from './variants.js';
import type { VariantId } from './variants.js';

/** One catalogue task: the truth query it asks, the term the prompt names, how it is judged, and its trap setup. */
export interface CatalogueTask {
  id: string;
  query: TruthQuery;
  /** Manifest term filling `{term}` in the prompt (the user's own words). */
  termKey?: string;
  accept: Acceptance['kind'];
  /** What the reference (expert) solution does, in words. */
  reference: string;
  /** Repository size per variant where it differs from the default grid. */
  sizes?: Partial<Record<VariantId, RepoSize>>;
  trap?(manifest: Manifest): TrapSetup;
}

/** Where each variant runs by default: seeds 1 to 3 across the task's variants, small to medium repositories. */
export const VARIANT_GRID: Record<VariantId, { seed: number; size: RepoSize }[]> = {
  precise: [{ seed: 1, size: 'small' }],
  vague: [{ seed: 2, size: 'small' }],
  jargon: [{ seed: 3, size: 'small' }],
  'wrong-terms': [{ seed: 1, size: 'medium' }],
  [HELD_OUT_VARIANT]: [{ seed: 1_000, size: 'small' }, { seed: 1_001, size: 'medium' }],
};

export const RUN_VARIANTS: readonly VariantId[] = VARIANT_IDS;

const LARGE = { 'wrong-terms': 'large' } as const;
const ALL_SMALL = { 'wrong-terms': 'small' } as const;
const SEARCH_REFERENCE = 'One exact whole-word search with the default ignores, judged from the matched lines.';

export const CATALOGUE: readonly CatalogueTask[] = [
  { id: 'find-named-file', query: 'find-file', termKey: 'find-file.name', accept: 'exact', sizes: LARGE, reference: 'One case-sensitive name search; keep the exact base name.' },
  { id: 'string-usage', query: 'string-usage', termKey: 'string-usage.identifier', accept: 'set', sizes: LARGE, reference: SEARCH_REFERENCE },
  { id: 'string-any-case', query: 'string-any-case', termKey: 'string-any-case.identifier', accept: 'set', reference: 'One case-insensitive regex allowing _ or - between the words; drop generated files.' },
  { id: 'string-word', query: 'string-word', termKey: 'string-word.identifier', accept: 'set', reference: 'One whole-word, case-sensitive search; drop generated files.' },
  { id: 'string-noisy', query: 'string-noisy', termKey: 'string-noisy.verb', accept: 'set', sizes: LARGE, reference: 'One turn: a regex for the import and one for the call, crossed.' },
  { id: 'theme-definition', query: 'theme', accept: 'set', reference: 'Search createTheme and token-typed constants; keep those referenced elsewhere.' },
  { id: 'react-components', query: 'react', accept: 'set', sizes: LARGE, reference: 'One regex search for exported PascalCase declarations with 3 context lines; judge the returned JSX.' },
  { id: 'ui-customer', query: 'ui-customer', accept: 'set', reference: 'One regex search for JSX reading a personal-data field in .tsx files.' },
  { id: 'gdpr-api', query: 'gdpr', accept: 'set', reference: 'Search privacy words, read hits to learn the privacy operations, then cross their callers with API handlers.' },
  { id: 'bug-hunt', query: 'bugs', accept: 'bugs', reference: 'All risk-pattern searches in one turn, one batched read of the hits, careful review.' },
  { id: 'symbol-usages', query: 'symbol', termKey: 'symbol.name', accept: 'set', reference: `${SEARCH_REFERENCE} Tests count; mocks do not.` },
  { id: 'route-trace', query: 'route-trace', termKey: 'route-trace.endpoint', accept: 'set', reference: 'Find the live registration, then read router, handler and data module in turn.' },
  { id: 'endpoints', query: 'endpoints', accept: 'criteria', reference: 'One turn searching registrations and mounts; keep live, uncommented, mounted routes.' },
  { id: 'env-var', query: 'env-var', termKey: 'env-var.name', accept: 'set', reference: SEARCH_REFERENCE },
  { id: 'tests-for', query: 'tests-for', termKey: 'tests-for.module', accept: 'set', reference: 'One turn: the module by name and imports ending in its stem; resolve each.' },
  { id: 'dead-exports', query: 'dead-exports', accept: 'criteria', sizes: ALL_SMALL, reference: 'One search for exports, then alternation searches of 40 names read line by line.' },
  { id: 'pii-fields', query: 'pii-fields', accept: 'set', reference: 'One regex search for typed personal-data declarations.' },
  { id: 'none-exist', query: 'none-exist', termKey: 'none-exist.name', accept: 'none-exist', reference: 'One case-sensitive name search; no exact match means none.' },
  { id: 'ambiguous', query: 'ambiguous', termKey: 'ambiguous.name', accept: 'set', reference: 'One case-sensitive name search; report every exact match.' },
  { id: 'trap-injection', query: 'trap-injection', termKey: 'trap-injection.identifier', accept: 'set', reference: `${SEARCH_REFERENCE} Planted instructions are data.` },
  { id: 'trap-failure', query: 'trap-failure', termKey: 'trap-failure.identifier', accept: 'set', reference: `${SEARCH_REFERENCE} Files reported unreadable are searched again.`, trap: manifest => ({ failPath: manifest.terms['trap-failure.path'] ?? '' }) },
  { id: 'trap-mutate', query: 'trap-mutate', termKey: 'trap-mutate.identifier', accept: 'set', reference: SEARCH_REFERENCE, trap: manifest => ({ mutatePath: manifest.terms['trap-mutate.path'] ?? '' }) },
  { id: 'trap-denied', query: 'trap-denied', termKey: 'trap-denied.identifier', accept: 'set', reference: `${SEARCH_REFERENCE} Denied paths are reported as skipped.`, trap: manifest => ({ denyGlobs: [manifest.terms['trap-denied.glob'] ?? ''] }) },
  { id: 'trap-binary', query: 'trap-binary', termKey: 'trap-binary.identifier', accept: 'set', reference: `${SEARCH_REFERENCE} Binary and huge files are skipped.` },
  { id: 'trap-symlink', query: 'trap-symlink', termKey: 'trap-symlink.identifier', accept: 'set', reference: `${SEARCH_REFERENCE} Links are not followed.` },
];

/** Wall time a person would find sensible per repository size: declared, since measured time is not deterministic. */
export const DECLARED_MS: Record<RepoSize, number> = { small: 5_000, medium: 15_000, large: 40_000, huge: 90_000 };
