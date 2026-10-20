import type { FsAccess, PathPlatform } from './fs-access.js';

export type FsPermission = 'read' | 'write' | 'delete';

/** A directory the filesystem tools may use, and what they may do under it. */
export interface FsRoot {
  /** Absolute. Resolved through `realpath` (symlinks, junctions, short names) before any comparison. */
  path: string;
  permissions: FsPermission[];
  /** Shown in denials and suggestions instead of the path. */
  label?: string;
}

/** One filesystem operation, as `FsPolicyOptions.approval` sees it. */
export interface FsOperation {
  permission: FsPermission;
  /** The canonical path. */
  path: string;
  /** The tool asking (`fs_write`, `fs_delete`...). */
  tool?: string;
}

/** `createFsPolicy(options)`. Deny by default: without roots every request is refused. */
export interface FsPolicyOptions {
  roots: FsRoot[];
  /**
   * Globs (relative to their root, `/` separated) that are refused. Default: `.git` contents, `.env` files, `*.pem`
   * and `*.key` for every permission, and `node_modules` for write and delete only. Given, they replace the default
   * and apply to every permission.
   */
  denyGlobs?: string[];
  /** Largest file read whole (default 1 MiB); larger files are read in parts or truncated. */
  maxReadBytes?: number;
  /** Largest content written at once (default 1 MiB). */
  maxWriteBytes?: number;
  /** Most entries a listing or search visits (default 10_000). */
  maxFiles?: number;
  /** Default: the platform's (case-insensitive on Windows and macOS). */
  caseSensitive?: boolean;
  /** Whether an operation needs a person's approval (in addition to `fsTools({ approvals })`). */
  approval?(operation: FsOperation): boolean;
  /** Relative paths start here (absolute); default the first root. */
  cwd?: string;
  /** Path rules to apply; default the access's platform. Tests inject it to run Windows rules anywhere. */
  platform?: PathPlatform;
}

/** Why a request was refused. */
export type PolicyDenialCode = 'no_roots' | 'outside_roots' | 'permission_denied' | 'denied_glob' | 'invalid_path' | 'too_large';

/** The policy's answer: the canonical path to use (and the root it is under), or why not. */
export type PolicyDecision =
  | { allowed: true; canonicalPath: string; root: string }
  | { allowed: false; code: PolicyDenialCode; message: string; suggestion?: string };

/** `FsPolicy.check`. */
export interface FsCheckRequest {
  path: string;
  permission: FsPermission;
  access: FsAccess;
  /** Writes: the size of the content, checked against `maxWriteBytes`. */
  bytes?: number;
  /**
   * Default true. False resolves every segment but the last, so a final symlink or junction names itself (its own
   * place is checked), not its target: what deleting, moving or describing a link acts on.
   */
  followFinalLink?: boolean;
}

/** The canonical form of a path, or why it is unusable. */
export type CanonicalPath = { ok: true; path: string } | { ok: false; message: string };

/** The only authority on which paths the filesystem tools may touch. */
export interface FsPolicy {
  /** Canonicalises the path, then checks roots, permissions, deny globs and size. */
  check(request: FsCheckRequest): Promise<PolicyDecision>;
  /** Absolute, separators normalised, `..` applied, symlinks of the existing prefix resolved (see `followFinalLink`). */
  canonicalise(params: { path: string; access: FsAccess; followFinalLink?: boolean }): Promise<CanonicalPath>;
  /** The lexical part of `canonicalise` only (no disk access, so links are not resolved): for synchronous checks. */
  lexical(params: { path: string; access: FsAccess }): CanonicalPath;
  /** Whether the canonical path is refused by a deny glob for this permission (used while walking directories). */
  isDenied(params: { path: string; root: string; permission: FsPermission; access: FsAccess }): boolean;
  needsApproval(operation: FsOperation): boolean;
  limits: { maxReadBytes: number; maxWriteBytes: number; maxFiles: number };
  caseSensitive(access: FsAccess): boolean;
  roots: readonly FsRoot[];
}
