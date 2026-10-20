import { createAigentError } from '../core/aigent-error.js';
import { lexicalPath, relativeTo, resolveExisting } from './canonical-path.js';
import type { FsAccess, PathPlatform } from './fs-access.js';
import type { CanonicalPath, FsPermission, FsPolicy, FsPolicyOptions, FsRoot, PolicyDecision } from './fs-policy-types.js';
import { globRegExp } from './glob.js';
import { comparable, isCaseSensitiveByDefault, separatorOf, splitAbsolute } from './path-flavour.js';

const MIB = 1_048_576;
const DEFAULT_MAX_FILES = 10_000;
const PERMISSIONS: readonly FsPermission[] = ['read', 'write', 'delete'];
/** Refused for every permission unless `denyGlobs` replaces them: VCS internals, environment files and keys. */
const DEFAULT_DENY_ALL = ['**/.git/**', '**/.env', '**/.env.*', '**/*.pem', '**/*.key'];
/** Refused for write and delete only: installed packages may be read, never changed. */
const DEFAULT_DENY_CHANGES = ['**/node_modules/**'];

function invalidDefinition(message: string): never {
  throw createAigentError({ code: 'invalid_definition', message: `createFsPolicy: ${message}`, details: { option: 'roots' } });
}

function validateRoots(params: { roots: FsRoot[]; platform: PathPlatform | undefined }): void {
  const { roots, platform } = params;
  for (const { path, permissions } of roots) {
    const flavours: PathPlatform[] = platform == null ? ['posix', 'win32'] : [platform];
    if (typeof path !== 'string' || flavours.every(flavour => splitAbsolute({ path, platform: flavour }) == null)) invalidDefinition(`root '${String(path)}' must be an absolute path`);
    if (!Array.isArray(permissions) || permissions.some(permission => !PERMISSIONS.includes(permission))) invalidDefinition(`root '${path}' permissions must be some of ${PERMISSIONS.join(', ')}`);
  }
}

/** Whether `path` is `root` or below it (compared as the file system compares names). */
function isWithin(params: { path: string; root: string; separator: string; caseSensitive: boolean }): boolean {
  const { path, root, separator, caseSensitive } = params;
  const candidate = comparable({ path, caseSensitive });
  const base = comparable({ path: root, caseSensitive });
  return candidate === base || candidate.startsWith(base.endsWith(separator) ? base : base + separator);
}

/**
 * The path authority every filesystem tool goes through: deny by default, every path canonicalised (symlinks of the
 * existing prefix resolved) before it is checked, and the checked canonical path is the one the tool then uses.
 */
export function createFsPolicy(options: FsPolicyOptions): FsPolicy {
  const { roots, denyGlobs, maxReadBytes = MIB, maxWriteBytes = MIB, maxFiles = DEFAULT_MAX_FILES, approval, cwd } = options;
  validateRoots({ roots, platform: options.platform });
  const platformOf = (access: FsAccess): PathPlatform => options.platform ?? access.platform;
  const caseSensitive = (access: FsAccess): boolean => options.caseSensitive ?? isCaseSensitiveByDefault(platformOf(access));

  function globsFor(permission: FsPermission): string[] {
    if (denyGlobs != null) return denyGlobs;
    return permission === 'read' ? DEFAULT_DENY_ALL : [...DEFAULT_DENY_ALL, ...DEFAULT_DENY_CHANGES];
  }

  async function canonicalise(params: { path: string; access: FsAccess }): Promise<CanonicalPath> {
    const { path, access } = params;
    const platform = platformOf(access);
    const base = splitAbsolute({ path: cwd ?? roots[0]?.path ?? separatorOf(platform), platform }) ?? { root: separatorOf(platform), segments: [] };
    const allowUnc = roots.some(root => root.path.startsWith('\\\\') || root.path.startsWith('//'));
    const lexical = lexicalPath({ path, platform, base, allowUnc });
    if (!lexical.ok) return lexical;
    return resolveExisting({ parts: lexical.parts, platform, access });
  }

  /** Roots in canonical form (a root that does not exist yet stays lexical). */
  async function canonicalRoots(access: FsAccess): Promise<{ root: FsRoot; path: string }[]> {
    const resolved = await Promise.all(roots.map(async root => ({ root, canonical: await canonicalise({ path: root.path, access }) })));
    return resolved.flatMap(({ root, canonical }) => (canonical.ok ? [{ root, path: canonical.path }] : []));
  }

  function isDenied(params: { path: string; root: string; permission: FsPermission; access: FsAccess }): boolean {
    const { path, root, permission, access } = params;
    const relative = relativeTo({ path, root, platform: platformOf(access) });
    const isExact = caseSensitive(access);
    // `<path>/x` also tests the path as a directory, so `**/.git/**` refuses the `.git` directory itself.
    return globsFor(permission).some(pattern => {
      const regex = globRegExp({ pattern, caseSensitive: isExact });
      return regex.test(relative) || regex.test(`${relative}/x`);
    });
  }

  const describeRoots = (): string => roots.map(({ path, label, permissions }) => `${label ?? path} (${permissions.join(', ')})`).join('; ');

  async function check(request: Parameters<FsPolicy['check']>[0]): Promise<PolicyDecision> {
    const { path, permission, access, bytes } = request;
    if (roots.length === 0) return { allowed: false, code: 'no_roots', message: 'No filesystem roots are configured, so every path is refused', suggestion: 'Configure createFsPolicy({ roots: [{ path, permissions }] }) for the directories the agent may use' };
    const canonical = await canonicalise({ path, access });
    if (!canonical.ok) return { allowed: false, code: 'invalid_path', message: `Path '${path}' cannot be used: ${canonical.message}`, suggestion: 'Use a plain absolute path, or a path relative to the workspace root' };
    const separator = separatorOf(platformOf(access));
    const matches = (await canonicalRoots(access)).filter(({ path: rootPath }) => isWithin({ path: canonical.path, root: rootPath, separator, caseSensitive: caseSensitive(access) }));
    // The innermost root decides, so a read-only directory inside a writable one stays read-only.
    const [match] = matches.sort((first, second) => second.path.length - first.path.length);
    if (match == null) return { allowed: false, code: 'outside_roots', message: `Path '${path}' (resolved to '${canonical.path}') is outside every allowed root`, suggestion: `Allowed roots: ${describeRoots()}` };
    const { root, path: rootPath } = match;
    const label = root.label ?? root.path;
    if (!root.permissions.includes(permission)) return { allowed: false, code: 'permission_denied', message: `Root '${label}' does not allow ${permission} (it allows ${root.permissions.join(', ')})`, suggestion: `Choose a path under a root that allows ${permission}` };
    if (isDenied({ path: canonical.path, root: rootPath, permission, access })) return { allowed: false, code: 'denied_glob', message: `Path '${path}' is protected (${permission} refused by a deny rule)`, suggestion: 'Leave protected files (VCS data, secrets, installed packages) alone' };
    if (permission === 'write' && bytes != null && bytes > maxWriteBytes) return { allowed: false, code: 'too_large', message: `Writing ${bytes} bytes to '${path}' exceeds the limit of ${maxWriteBytes} bytes`, suggestion: 'Write smaller files, or edit the file in parts' };
    return { allowed: true, canonicalPath: canonical.path, root: rootPath };
  }

  return {
    check, canonicalise, isDenied,
    needsApproval: operation => approval?.(operation) ?? false,
    limits: { maxReadBytes, maxWriteBytes, maxFiles },
    caseSensitive,
    roots,
  };
}
