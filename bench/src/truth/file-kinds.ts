import type { RepoTree, TreeEntry } from '../generate/repo-types.js';

/** Directories holding installed, generated, vendored or built material (never "source"). */
const GENERATED_DIRS = ['node_modules', 'dist', 'build', 'out', 'coverage', '.next', 'vendor', '.git'];
const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Under a dependency, build, vendored or VCS directory, a lockfile or a minified file. */
export function isGeneratedOrVendored(path: string): boolean {
  const segments = path.split('/');
  if (segments.slice(0, -1).some(segment => GENERATED_DIRS.includes(segment))) return true;
  const name = baseName(path);
  return LOCKFILES.includes(name) || /\.min\.(js|css)$/.test(name);
}

/** Tests, test support, mocks and snapshots. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes('/__tests__/') || path.includes('/__mocks__/') || path.endsWith('.snap');
}

export function isStory(path: string): boolean {
  return /\.stories\.[jt]sx?$/.test(path);
}

/** Text content (not binary, not a link). */
export function textOf(entry: TreeEntry | undefined): string | undefined {
  return typeof entry === 'string' ? entry : undefined;
}

/** Hand-written source code: a code file that is not generated, vendored, a test, a story or a declaration file. */
export function isSourceCode(path: string): boolean {
  return SOURCE_EXTENSIONS.test(path) && !path.endsWith('.d.ts') && !isGeneratedOrVendored(path) && !isTestFile(path) && !isStory(path);
}

/** Every regular text file with its content, in path order. */
export function textFiles(tree: RepoTree): { path: string; text: string }[] {
  return [...tree.entries()].flatMap(([path, entry]) => (typeof entry === 'string' ? [{ path, text: entry }] : [])).sort((first, second) => first.path.localeCompare(second.path));
}
