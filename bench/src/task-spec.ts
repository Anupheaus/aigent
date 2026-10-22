import type { RepoSize } from './generate/repo-types.js';
import type { GroundTruth, TruthQuery } from './truth/truth-types.js';

export type { GroundTruth, TruthQuery } from './truth/truth-types.js';

/** Limits a run must stay within for a tier. */
export interface Budget {
  /** Estimated tokens sent and received over the whole run (`ceil(chars / 4)`). */
  maxTokens: number;
  /** Model requests. */
  maxTurns: number;
  /** Tool calls executed (a batch call counts once). */
  maxToolCalls: number;
  /** Wall time. */
  maxMs: number;
}

/** How an answer is judged: the kind of comparison and the thresholds a correct answer must meet. */
export interface Acceptance {
  kind: 'exact' | 'set' | 'bugs' | 'none-exist' | 'criteria';
  minRecall: number;
  minPrecision: number;
}

/** A look-alike the task is designed to catch (counted as a decoy hit when answered). */
export interface DecoyRef {
  path: string;
  reason: string;
  /** Bug-hunt look-alikes: the line of the look-alike construct. */
  line?: number;
  /** Criteria tasks: the item (endpoint, identifier) that must not be listed. */
  item?: string;
}

/** One step of the reference (expert) solution. */
export interface ReferenceStep {
  tool: string;
  /** Items in the call (batch tools) or 1. */
  items: number;
  purpose: string;
}

/** The expert path the budgets derive from, measured by running the reference policy on the generated repository. */
export interface ReferenceSolution {
  description: string;
  steps: ReferenceStep[];
  measured: { tokens: number; turns: number; toolCalls: number; ms: number };
  /** Held-out specs only: why the reference answer was wrong (a tuning spec with a wrong reference is never built). */
  failures?: string[];
}

/** Hostile conditions the harness sets up for a trap task (never shown to solvers). */
export interface TrapSetup {
  /** The first read of this repo path fails (an injected tool failure the solver must recover from). */
  failPath?: string;
  /** This repo path changes on every read. */
  mutatePath?: string;
  /** Extra deny globs for the task's `FsPolicy` (added to the defaults). */
  denyGlobs?: string[];
}

/**
 * A benchmark task: what the solver is given (prompt, scope, context) and what only the bench sees (ground truth,
 * decoys, acceptance, budgets, reference). Budgets are derived from the reference solution, never from agent runs.
 */
export interface TaskSpec {
  /** `<task>/<variant>/<size>/s<seed>`. */
  id: string;
  /** The catalogue task (e.g. `find-named-file`). */
  family: string;
  /** Wording, ambiguity or noise variant id. */
  variant: string;
  prompt: string;
  scope: string[];
  context?: string;
  /** The truth query answering this task. */
  query: TruthQuery;
  repo: { seed: number; size: RepoSize };
  /** Held out from tuning: run only with `--held-out`. */
  heldOut: boolean;
  /** Words of the prompt that are the user's own question (a file name, an identifier): exempt from hint linting. */
  givenTerms: string[];
  groundTruth: GroundTruth;
  decoys: DecoyRef[];
  accept: Acceptance;
  budgets: { pass: Budget; target: Budget; stretch: Budget };
  reference: ReferenceSolution;
  trap?: TrapSetup;
}

/** A solver's structured answer. */
export type SolverAnswer =
  | { files: string[] }
  | { bugs: { path: string; line: number; cause: string }[] }
  | { none: true }
  | { text: string };
