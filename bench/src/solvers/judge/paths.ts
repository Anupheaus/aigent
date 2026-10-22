/**
 * How a careful engineer reads paths (the policies' own judgement, written independently of the ground truth): what
 * is generated or vendored, what is a test, and what is hand-written code.
 */
const BUILD_SEGMENTS = new Set(['dist', 'build', 'out', 'coverage', 'node_modules', 'vendor', '.next', '.git']);
const LOCK_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

export function isBuildOrVendor(path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  return parts.slice(0, -1).some(part => BUILD_SEGMENTS.has(part)) || LOCK_NAMES.has(name) || name.includes('.min.');
}

export function isTestLike(path: string): boolean {
  return /\.(test|spec)\.\w+$/.test(path) || /(^|\/)(__tests__|__mocks__|__snapshots__)\//.test(path) || path.endsWith('.snap');
}

export const isStoryFile = (path: string): boolean => path.includes('.stories.');

export const isCodeFile = (path: string): boolean => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path) && !path.endsWith('.d.ts');

/** Hand-written, shipped code: not generated, vendored, a test, a mock or a story. */
export function isOwnCode(path: string): boolean {
  return isCodeFile(path) && !isBuildOrVendor(path) && !isTestLike(path) && !isStoryFile(path);
}

/** The directory of a path (`''` at the root). */
export const dirName = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Resolves a relative import specifier from a file to the repo path it names, trying the usual extensions. */
export function resolveImport(params: { from: string; specifier: string; known: (path: string) => boolean }): string | undefined {
  const { from, specifier, known } = params;
  if (!specifier.startsWith('.')) return undefined;
  const parts = dirName(from).split('/').filter(part => part !== '');
  for (const piece of specifier.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.' && piece !== '') parts.push(piece);
  }
  const base = parts.join('/');
  return ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map(suffix => base + suffix).find(known);
}
