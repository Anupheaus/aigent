import type { BugCause } from '../generate/families/bug-constructs.js';

/** The questions ground truth can answer; a task names one. */
export const TRUTH_QUERIES = [
  'find-file', 'none-exist', 'ambiguous', 'string-usage', 'string-any-case', 'string-word', 'string-noisy', 'theme', 'react',
  'ui-customer', 'gdpr', 'bugs', 'symbol', 'route-trace', 'endpoints', 'env-var', 'tests-for', 'dead-exports', 'pii-fields',
  'trap-injection', 'trap-failure', 'trap-mutate', 'trap-denied', 'trap-binary', 'trap-symlink',
] as const;

export type TruthQuery = typeof TRUTH_QUERIES[number];

/** A real bug: where it is and its root-cause class. */
export interface BugTruth {
  path: string;
  /** 1-based line of the faulty construct. */
  line: number;
  cause: BugCause;
}

/** The correct answer, computed by exhaustive scripts from the generated files alone. */
export type GroundTruth =
  | { kind: 'files'; files: string[]; alternatives?: string[][] }
  | { kind: 'none' }
  | { kind: 'bugs'; bugs: BugTruth[] }
  | { kind: 'criteria'; itemKind: 'endpoint' | 'identifier'; required: string[]; forbidden: string[] };
