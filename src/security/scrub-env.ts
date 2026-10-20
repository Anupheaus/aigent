import type { PathPlatform } from './fs-access.js';

/** What a child process may see of the environment: allowlisted names only, plus fixed values. */
export interface EnvSpec {
  /** Variable names passed through from the parent (compared case-insensitively on Windows). No wildcards. */
  allow: readonly string[];
  /** Values set for the child (win over passed-through ones). */
  set?: Readonly<Record<string, string>>;
}

/**
 * Names that are passed through by default: what programs need to run (search path, home, temp, locale, Windows
 * system directories), never credentials. Anything else (`AWS_*`, `*_TOKEN`, `NPM_TOKEN`...) is absent in the child.
 */
export const DEFAULT_ENV_ALLOW: readonly string[] = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'PATHEXT', 'COMSPEC'];

/**
 * The child's environment: only the allowlisted names of `parent` (case-insensitively on Windows, where the
 * environment is case-insensitive), then `spec.set`. Undefined parent values are dropped.
 */
export function scrubEnv(params: { parent: Readonly<Record<string, string | undefined>>; spec: EnvSpec; platform: PathPlatform }): Record<string, string> {
  const { parent, spec: { allow, set = {} }, platform } = params;
  const normalise = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  const allowed = new Set(allow.map(normalise));
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value != null && allowed.has(normalise(name))) child[name] = value;
  }
  for (const [name, value] of Object.entries(set)) {
    // A set value replaces a passed-through one of any case, so Windows never sees two spellings.
    for (const existing of Object.keys(child)) if (normalise(existing) === normalise(name)) delete child[existing];
    child[name] = value;
  }
  return child;
}
