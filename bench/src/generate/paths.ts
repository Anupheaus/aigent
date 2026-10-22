/** The directory part of a repo-relative path (`''` at the root). */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The import specifier from one source file to another, without extension and `/index` (`./x`, `../y/z`). */
export function relativeImport(params: { from: string; to: string }): string {
  const { from, to } = params;
  const fromParts = dirOf(from).split('/').filter(part => part !== '');
  const toParts = to.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '').split('/');
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length - 1 && fromParts[shared] === toParts[shared]) shared += 1;
  const ups = fromParts.length - shared;
  const rest = toParts.slice(shared).join('/');
  return ups === 0 ? `./${rest}` : `${'../'.repeat(ups)}${rest}`;
}
