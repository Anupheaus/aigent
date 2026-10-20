import { globRegExp } from './glob.js';

/** One line of a `.gitignore`-style file. */
export interface IgnoreRule {
  /** A glob relative to the file's directory. */
  pattern: string;
  /** `!pattern`: re-includes what an earlier rule ignored. */
  isNegated: boolean;
  /** `pattern/`: matches directories only. */
  isDirectoryOnly: boolean;
}

/**
 * Skipped by `fs_search` unless `includeIgnored`: installed packages, VCS data, build output, lockfiles and minified
 * files, which are large and rarely what a search is after (and are reported as skipped, never silently).
 */
export const DEFAULT_SEARCH_IGNORES: readonly string[] = [
  'node_modules/', '.git/', '.hg/', '.svn/', 'dist/', 'build/', 'out/', 'coverage/', '.next/', '.turbo/', '__pycache__/',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'composer.lock', '*.min.js', '*.min.css',
];

/** Parses `.gitignore` text: comments, blanks, `\#` escapes, `!` negation, trailing `/` and anchoring by inner `/`. */
export function parseIgnoreFile(text: string): IgnoreRule[] {
  return text.split(/\r?\n/).flatMap(rawLine => {
    // Trailing spaces are dropped unless escaped; a leading `#` starts a comment.
    const line = rawLine.replace(/(?<!\\)\s+$/, '');
    if (line === '' || line.startsWith('#')) return [];
    const isNegated = line.startsWith('!');
    let pattern = (isNegated ? line.slice(1) : line).replace(/^\\([#!])/, '$1');
    const isDirectoryOnly = pattern.endsWith('/');
    if (isDirectoryOnly) pattern = pattern.slice(0, -1);
    // A slash at the start or in the middle anchors the pattern to the file's directory; otherwise it matches at any depth.
    const isAnchored = pattern.includes('/');
    pattern = pattern.replace(/^\//, '');
    if (!isAnchored && !pattern.startsWith('**/')) pattern = `**/${pattern}`;
    return pattern === '' ? [] : [{ pattern, isNegated, isDirectoryOnly }];
  });
}

/** Whether a path (relative, `/` separated) is ignored by the rules; the last matching rule wins. */
export type IgnoreMatcher = (entry: { path: string; isDirectory: boolean }) => boolean;

export function createIgnoreMatcher(params: { rules: IgnoreRule[]; caseSensitive?: boolean }): IgnoreMatcher {
  const { rules, caseSensitive = true } = params;
  const compiled = rules.map(rule => ({ ...rule, regex: globRegExp({ pattern: rule.pattern, caseSensitive }) }));
  return ({ path, isDirectory }) => {
    let isIgnored = false;
    for (const { regex, isNegated, isDirectoryOnly } of compiled) {
      if (isDirectoryOnly && !isDirectory) continue;
      if (regex.test(path)) isIgnored = !isNegated;
    }
    return isIgnored;
  };
}
