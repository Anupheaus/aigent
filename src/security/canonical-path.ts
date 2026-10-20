import { fsErrorCode } from './fs-access.js';
import type { FsAccess, PathPlatform } from './fs-access.js';
import { joinParts, separatorOf, splitAbsolute } from './path-flavour.js';
import type { PathParts } from './path-flavour.js';

/** A path reduced to an absolute, `.`/`..`-free form, or why it cannot be used. */
export type LexicalResult = { ok: true; parts: PathParts } | { ok: false; message: string };

/** Where a path starts and its raw segments (still holding `.` and `..`). */
type Anchored = { ok: true; root: string; raw: string[] } | { ok: false; message: string };

/** Longest path accepted (the Windows extended-length limit). */
export const MAX_PATH_CHARS = 32_767;
/** Longest single path segment on common file systems. */
export const MAX_SEGMENT_CHARS = 255;

/** Control characters (NUL included) are never part of a usable path. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Invisible formatting characters (bidirectional overrides, zero-width spaces...), which can make a name read as another. */
const FORMAT_CHARS = /\p{Cf}/u;
/** Characters Windows forbids in names (`:` is checked separately: it marks alternate data streams). */
const WIN_FORBIDDEN = /[<>"|?*]/;
/** Reserved device names, with or without an extension (`NUL`, `com1.txt`, `CONIN$`...). */
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
/** `PROGRA~1`: a short (8.3) name can alias a different long name, so it is never trusted. */
const WIN_SHORT_NAME = /~[0-9]/;

function winSegmentProblem(segment: string): string | undefined {
  if (segment === '.' || segment === '..') return undefined;
  if (segment.includes(':')) return `'${segment}' names an alternate data stream (':' is not allowed in a name)`;
  if (WIN_FORBIDDEN.test(segment)) return `'${segment}' contains a character Windows forbids in names`;
  if (/[. ]$/.test(segment)) return `'${segment}' ends with a dot or space, which Windows silently drops`;
  if (WIN_DEVICE.test(segment)) return `'${segment}' is a reserved Windows device name`;
  if (WIN_SHORT_NAME.test(segment)) return `'${segment}' looks like a short (8.3) name, which can alias another file`;
  return undefined;
}

/** The absolute start of `path` and its raw segments (still holding `.` and `..`), resolved against `base` if relative. */
function anchor(params: { path: string; platform: PathPlatform; base: PathParts; allowUnc: boolean }): Anchored {
  const { path, platform, base, allowUnc } = params;
  if (platform === 'posix') {
    const raw = path.split('/');
    return path.startsWith('/') ? { ok: true, root: '/', raw } : { ok: true, root: base.root, raw: [...base.segments, ...raw] };
  }
  const normalised = path.replace(/\//g, '\\');
  if (/^\\\\[?.]\\/.test(normalised)) return { ok: false, message: 'device and extended-length paths (\\\\?\\, \\\\.\\) are not allowed' };
  if (normalised.startsWith('\\\\')) {
    if (!allowUnc) return { ok: false, message: 'network (UNC) paths are not allowed: no root is a network share' };
    const parts = splitAbsolute({ path: normalised, platform });
    return parts == null ? { ok: false, message: 'a network path needs a server and a share' } : { ok: true, root: parts.root, raw: parts.segments };
  }
  if (/^[A-Za-z]:/.test(normalised)) {
    if (normalised[2] !== '\\') return { ok: false, message: `'${path.slice(0, 2)}' without a separator is drive-relative (its meaning depends on hidden state); use an absolute path` };
    return { ok: true, root: `${normalised.slice(0, 2).toUpperCase()}\\`, raw: normalised.slice(3).split('\\') };
  }
  // `\dir` is rooted on the base's drive; anything else is relative to the base.
  if (normalised.startsWith('\\')) return { ok: true, root: base.root, raw: normalised.split('\\') };
  return { ok: true, root: base.root, raw: [...base.segments, ...normalised.split('\\')] };
}

/**
 * The lexical canonical form of `path` for `platform`: absolute (relative paths start at `base`), separators
 * normalised, `.` removed and `..` applied (never above the root). Rejects control characters, over-long paths and,
 * on Windows, drive-relative paths, device paths, UNC paths (unless allowed), alternate data streams, reserved device
 * names, short (8.3) names, forbidden characters and trailing dots or spaces. Symlinks are not looked at.
 */
export function lexicalPath(params: { path: string; platform: PathPlatform; base: PathParts; allowUnc?: boolean }): LexicalResult {
  const { path, platform, base, allowUnc = false } = params;
  if (path === '') return { ok: false, message: 'the path is empty' };
  if (CONTROL_CHARS.test(path)) return { ok: false, message: 'the path contains a NUL or control character' };
  if (FORMAT_CHARS.test(path)) return { ok: false, message: 'the path contains an invisible formatting character (such as a bidirectional override or zero-width space)' };
  if (path.length > MAX_PATH_CHARS) return { ok: false, message: `the path is longer than ${MAX_PATH_CHARS} characters` };
  const anchored = anchor({ path, platform, base, allowUnc });
  if (!anchored.ok) return anchored;
  const segments: string[] = [];
  for (const segment of anchored.raw) {
    if (segment.length > MAX_SEGMENT_CHARS) return { ok: false, message: `a path segment is longer than ${MAX_SEGMENT_CHARS} characters` };
    const problem = platform === 'win32' ? winSegmentProblem(segment) : undefined;
    if (problem != null) return { ok: false, message: problem };
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { segments.pop(); continue; }
    segments.push(segment);
  }
  return { ok: true, parts: { root: anchored.root, segments } };
}

/** File-system errors that mean "this prefix does not exist yet": the canonical path keeps the rest as written. */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Resolves symlinks (and on Windows short names and junctions) through `access.realpath` for the longest prefix that
 * exists (with `followFinalLink: false`, of the parent only: the last name is kept, so a final link stays the link),
 * then re-attaches the segments after it, which are lexical and hold no `..`. The result is the one string
 * every later operation must use.
 */
export async function resolveExisting(params: { parts: PathParts; platform: PathPlatform; access: FsAccess; followFinalLink?: boolean }): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const { parts, platform, access, followFinalLink = true } = params;
  const last = parts.segments.at(-1);
  if (!followFinalLink && last != null) {
    // The parent is resolved; the last name is kept as written, so a link there stays the link.
    const parent = await resolveExisting({ parts: { root: parts.root, segments: parts.segments.slice(0, -1) }, platform, access });
    if (!parent.ok) return parent;
    const resolvedParent = splitAbsolute({ path: parent.path, platform });
    if (resolvedParent == null) return { ok: false, message: `'${parent.path}' is not an absolute path` };
    return { ok: true, path: joinParts({ parts: { root: resolvedParent.root, segments: [...resolvedParent.segments, last] }, platform }) };
  }
  for (let length = parts.segments.length; length >= 0; length -= 1) {
    const prefix = joinParts({ parts: { root: parts.root, segments: parts.segments.slice(0, length) }, platform });
    let real: string;
    try {
      real = await access.realpath(prefix);
    } catch (error) {
      const code = fsErrorCode(error);
      if (code != null && MISSING_CODES.has(code)) continue;
      return { ok: false, message: `'${prefix}' cannot be resolved (${code ?? String(error)})` };
    }
    const rest = parts.segments.slice(length);
    if (rest.includes('..')) return { ok: false, message: 'the path still holds .. after resolution' };
    const resolved = splitAbsolute({ path: real, platform });
    if (resolved == null) return { ok: false, message: `'${prefix}' resolves to '${real}', which is not an absolute path` };
    return { ok: true, path: joinParts({ parts: { root: resolved.root, segments: [...resolved.segments, ...rest] }, platform }) };
  }
  return { ok: true, path: joinParts({ parts, platform }) };
}

/** `path` relative to `root` with `/` separators ('' for the root itself), for glob matching. */
export function relativeTo(params: { path: string; root: string; platform: PathPlatform }): string {
  const { path, root, platform } = params;
  const separator = separatorOf(platform);
  const rest = path.length > root.length ? path.slice(root.length + (root.endsWith(separator) ? 0 : 1)) : '';
  return platform === 'win32' ? rest.replace(/\\/g, '/') : rest;
}
