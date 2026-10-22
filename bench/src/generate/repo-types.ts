import type { FsAccess } from '../../../src/tools/packs/fs/index.js';

/** Families of planted material; each plants needles (correct answers) and decoys (look-alikes that are wrong). */
export const FAMILY_IDS = [
  'file-find', 'string-search', 'theme', 'react', 'ui-customer', 'gdpr-api', 'bug-hunt', 'traps',
  'symbol', 'api-routes', 'env-var', 'test-map', 'dead-exports', 'pii-fields',
] as const;

export type FamilyId = typeof FAMILY_IDS[number];

/** Generated repository sizes and their approximate file counts. */
export const REPO_SIZES = { small: 300, medium: 2_000, large: 8_000, huge: 20_000 } as const;

export type RepoSize = keyof typeof REPO_SIZES;

/** A file's content, or a symbolic link to another path of the tree (relative to the repo root). */
export type TreeEntry = string | Uint8Array | { symlink: string };

/** The generated tree: repo-relative `/`-separated paths to entries. */
export type RepoTree = Map<string, TreeEntry>;

export type ManifestKind = 'needle' | 'decoy' | 'noise';

/**
 * One planted file. The manifest is for ground-truth checks and hint linting only and is never shown to solvers.
 * `answers` names the truth queries this file is a correct answer of; `decoyFor` those it is a look-alike for.
 */
export interface ManifestItem {
  /** `base`: the layout every repository has (the app shell, configs). */
  family: FamilyId | 'base';
  kind: ManifestKind;
  path: string;
  /** Why it was planted (e.g. "theme defined but never imported"). */
  reason: string;
  answers?: string[];
  decoyFor?: string[];
  /** Planted bugs and look-alikes: the 1-based line of the construct. */
  line?: number;
  /** Planted bugs: the root-cause class. */
  cause?: string;
  /** Distinctive strings (symbols, identifiers, endpoint paths) the hint linter must never see in task text. */
  distinctive?: string[];
}

/** The planted items plus the named terms tasks are phrased with (the name a user knows, the identifier asked about). */
export interface Manifest {
  seed: number;
  size: RepoSize;
  families: FamilyId[];
  items: ManifestItem[];
  /** e.g. `file-find.name` → `ledgerBalanceSummary.ts`. */
  terms: Record<string, string>;
  /** Criteria answers (endpoint lists, dead export names): truth query → required and forbidden items. */
  criteria: Record<string, { required: string[]; forbidden: string[] }>;
}

/** `generateRepo(params)`. */
export interface GenerateRepoParams {
  seed: number;
  size: RepoSize;
  families: FamilyId[];
  /** Default `memory` (an in-memory `FsAccess`, fast); `disk` writes a temp directory. */
  target?: 'memory' | 'disk';
}

export interface GeneratedRepo {
  /** Absolute root of the repository on `access`. */
  root: string;
  /** Number of regular files. */
  files: number;
  manifest: Manifest;
  access: FsAccess;
  tree: RepoTree;
  /** sha256 over every path and its bytes, in path order: equal seeds give equal hashes. */
  hash: string;
  /** Removes a disk repository; a no-op in memory. */
  cleanup(): Promise<void>;
}
