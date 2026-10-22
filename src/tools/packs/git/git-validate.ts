import { relativeTo } from '../../../security/canonical-path.js';
import { comparable, separatorOf } from '../../../security/path-flavour.js';
import type { FsPermission } from '../../../security/fs-policy-types.js';
import { toolFailure } from '../../tool-failure.js';
import type { GitDeps } from './git-shared.js';

/** A conservative ref: a branch, tag, hash or `HEAD~2`-style expression. Never an option, never a range. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~{}-]{0,199}$/;
/** `--since` values such as `2024-01-31`, `2024-01-31T10:00:00Z` or `2 weeks ago`. */
const SINCE = /^[0-9A-Za-z][0-9A-Za-z :.+-]{0,39}$/;
/** Most characters of an `--author` or `--grep` text (matched as a fixed string). */
const MAX_PATTERN_CHARS = 200;
/** Remote names: plain identifiers. */
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function invalid(params: { code: string; message: string; suggestion?: string }): never {
  throw toolFailure({ category: 'denied', retryable: false, ...params });
}

/** A ref the model gave: refused unless it matches `REF` and holds no `..` (ranges are not refs). */
export function validRef(params: { field: string; value: string }): string {
  const { field, value } = params;
  if (!REF.test(value) || value.includes('..')) invalid({ code: 'invalid_ref', message: `${field} '${value.slice(0, 80)}' is not an allowed ref (letters, digits and ._/@^~{}- only, no leading '-', no '..')`, suggestion: 'Give a branch, tag or commit hash' });
  return value;
}

export function validSince(value: string): string {
  if (!SINCE.test(value)) invalid({ code: 'invalid_since', message: `since '${value.slice(0, 80)}' is not a date such as 2024-01-31 or '2 weeks ago'` });
  return value;
}

/** A text matched literally (`--fixed-strings`): no NUL or line breaks, and short. */
export function validPattern(params: { field: string; value: string }): string {
  const { field, value } = params;
  if (value.length === 0 || value.length > MAX_PATTERN_CHARS || /[\0\r\n]/.test(value)) invalid({ code: 'invalid_pattern', message: `${field} must be 1..${MAX_PATTERN_CHARS} characters on one line` });
  return value;
}

export function validRemote(value: string): string {
  if (!REMOTE.test(value)) invalid({ code: 'invalid_remote', message: `Remote '${value.slice(0, 80)}' is not a plain remote name` });
  return value;
}

/**
 * A path inside the repository, as git wants it after `--` (relative, `/` separated). It must pass the FsPolicy check
 * for `permission` and stay inside the repository; options (`-x`) and pathspec magic (`:(...)`) are refused (git also
 * runs with literal pathspecs).
 */
export async function validRepoPath(params: { deps: GitDeps; repo: string; path: string; permission?: FsPermission }): Promise<string> {
  const { path } = params;
  if (path === '' || path.startsWith('-') || path.startsWith(':') || /[\0\r\n]/.test(path)) invalid({ code: 'invalid_path', message: `Path '${path.slice(0, 80)}' is not a plain path inside the repository` });
  return policyRepoPath(params);
}

/**
 * The paths git reported (relative, `/` separated) that the FsPolicy refuses for `permission` or that resolve outside
 * the repository. A pathspec such as `.` or no paths at all reaches every file below it, so what git would show or
 * commit is checked path by path.
 */
export async function deniedRepoPaths(params: { deps: GitDeps; repo: string; paths: readonly string[]; permission?: FsPermission }): Promise<string[]> {
  const { paths, ...rest } = params;
  const verdicts = await Promise.all(paths.map(path => policyRepoPath({ ...rest, path }).then(() => false, () => true)));
  return paths.filter((_path, index) => verdicts[index] === true);
}

async function policyRepoPath(params: { deps: GitDeps; repo: string; path: string; permission?: FsPermission }): Promise<string> {
  const { deps: { policy }, repo, path, permission = 'read' } = params;
  const { cwdPolicy, access } = policy;
  const separator = separatorOf(access.platform);
  const decision = await cwdPolicy.check({ path: `${repo}${separator}${path}`, permission, access });
  if (!decision.allowed) invalid({ code: decision.code, message: decision.message, ...(decision.suggestion == null ? {} : { suggestion: decision.suggestion }) });
  const caseSensitive = cwdPolicy.caseSensitive(access);
  const inside = comparable({ path: decision.canonicalPath, caseSensitive });
  const base = comparable({ path: repo, caseSensitive });
  if (inside !== base && !inside.startsWith(base.endsWith(separator) ? base : base + separator)) invalid({ code: 'outside_repository', message: `Path '${path}' resolves outside the repository '${repo}'` });
  return relativeTo({ path: decision.canonicalPath, root: repo, platform: access.platform }) || '.';
}
