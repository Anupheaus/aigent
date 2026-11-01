import type { Embedder } from '../knowledge/knowledge-types.js';
import { normalise } from '../knowledge/vector-math.js';
import { contentTerms } from './stop-words.js';

/**
 * Task texts written by hand as paraphrases of one memory each in `FIXTURE_MEMORIES`, sharing none of its content
 * words, so keyword search alone cannot find it (BM25 scores 0 of 10 by construction). Each is labelled with the
 * memory a person would want first. Circular by design: `SYNONYMS` below was written with these queries in view and
 * maps their words onto the memories' concepts, so a run over them tests the plumbing (embedding, vector storage,
 * fusion), not whether embedding recall finds paraphrases. `HELD_OUT_QUERIES` is the check that is not co-designed.
 */
export const PARAPHRASE_QUERIES: { query: string; expected: string }[] = [
  { query: 'Execute the system checks', expected: 'tests' },
  { query: 'Correct the orthography in the guides', expected: 'spelling' },
  { query: 'Ship the app to preprod', expected: 'deploy' },
  { query: 'Add an endpoint for invoices', expected: 'billing' },
  { query: 'Add the date-fns library to the project', expected: 'pnpm' },
  { query: 'Where do the credentials come from?', expected: 'secrets' },
  { query: 'Run the linter autofix prior to checking in', expected: 'lint' },
  { query: 'Modify a component in the browser UI', expected: 'frontend' },
  { query: 'Alter the db schema for orders', expected: 'migrations' },
  { query: 'Write up what changed in the new version', expected: 'release' },
];

/**
 * Task texts written later, as a user might type them, for the memories of `FIXTURE_MEMORIES`, without consulting
 * `SYNONYMS` or running any ranking; unlike `PARAPHRASE_QUERIES` they may share words with their memory. Nothing was
 * changed after the first run over them.
 */
export const HELD_OUT_QUERIES: { query: string; expected: string }[] = [
  { query: 'The integration suite keeps failing to connect, what do I start first?', expected: 'tests' },
  { query: 'Should the README say colour or color?', expected: 'spelling' },
  { query: 'Push this build out to the staging environment', expected: 'deploy' },
  { query: 'Where is the code that charges customers?', expected: 'billing' },
  { query: 'How do I add a new npm dependency here?', expected: 'pnpm' },
  { query: 'Where should I put the Stripe API token?', expected: 'secrets' },
  { query: 'The pre-commit hook complains about formatting', expected: 'lint' },
  { query: 'Which folder holds the web client?', expected: 'frontend' },
  { query: 'How do I apply the new table changes to the database?', expected: 'migrations' },
  { query: 'Document this fix for the next version', expected: 'release' },
];

/**
 * Words with the same meaning in this fixture's domain, written alongside `PARAPHRASE_QUERIES` (see there): each word
 * maps to a concept, and words without an entry are their own concept.
 */
const SYNONYMS: Record<string, string[]> = {
  test: ['test', 'tests', 'check', 'checks', 'spec', 'specs', 'suite'],
  integration: ['integration', 'system'],
  run: ['run', 'runs', 'running', 'execute', 'executing'],
  container: ['docker', 'container', 'containers'],
  database: ['database', 'db', 'schema', 'sql'],
  fix: ['fix', 'correct', 'repair', 'autofix'],
  spelling: ['spelling', 'orthography', 'spell'],
  documentation: ['documentation', 'docs', 'guide', 'guides', 'manual'],
  preference: ['prefer', 'prefers', 'preference', 'likes'],
  deploy: ['deploy', 'deployment', 'ship'],
  staging: ['staging', 'preprod'],
  billing: ['billing', 'invoice', 'invoices', 'payment', 'payments'],
  service: ['service', 'services'],
  package: ['package', 'packages', 'dependency', 'dependencies', 'library', 'libraries'],
  repo: ['repo', 'repository', 'project', 'codebase'],
  secret: ['secret', 'secrets', 'key', 'keys', 'credentials', 'vault', 'token', 'tokens'],
  lint: ['lint', 'linter', 'eslint', 'linting'],
  before: ['before', 'prior'],
  commit: ['commit', 'commits', 'committing', 'checking'],
  frontend: ['frontend', 'browser', 'ui', 'client'],
  react: ['react', 'component', 'components'],
  migration: ['migration', 'migrations', 'migrate'],
  release: ['release', 'releases', 'unreleased', 'version'],
  changelog: ['changelog', 'notes'],
  change: ['change', 'changes', 'changed', 'modify', 'alter', 'edit'],
};

const CONCEPT_OF = new Map(Object.entries(SYNONYMS).flatMap(([concept, words]) => words.map(word => [word, concept] as const)));
const DIMENSIONS = 512;
const FNV_OFFSET = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

function slotOf(concept: string): number {
  let hash = FNV_OFFSET;
  for (let at = 0; at < concept.length; at += 1) {
    hash ^= concept.charCodeAt(at);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash % DIMENSIONS;
}

export interface ConceptEmbedder extends Embedder {
  /** Every text sent to `embed`, in order. */
  embedded: string[];
}

/** A synonym-aware fake embedder: a text's content words mapped to concepts, counted into hashed slots, normalised. */
export function conceptEmbedder(options: { id?: string } = {}): ConceptEmbedder {
  const { id = 'concept-v1' } = options;
  const embedded: string[] = [];
  const embedOne = (text: string): number[] => {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    for (const term of contentTerms(text)) {
      const slot = slotOf(CONCEPT_OF.get(term) ?? term);
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
    return normalise(vector);
  };
  return {
    id, dimensions: DIMENSIONS, embedded,
    embed: async texts => {
      embedded.push(...texts);
      return texts.map(embedOne);
    },
  };
}
