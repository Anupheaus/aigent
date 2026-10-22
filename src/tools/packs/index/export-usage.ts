import type { FileCard } from './index-types.js';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * The exported names of each file that another code file uses, found through imports rather than by name: a named
 * or aliased import or re-export names it, an `export *` re-exports all of it, and a whole-module import (namespace,
 * dynamic `import()`, `require`) uses the names the importing file's code mentions. Uses inside the declaring file do
 * not count, and a same-named function elsewhere is not a use. `unresolvedNames` are names imported from specifiers
 * the index cannot resolve (packages, path aliases): callers keep those alive rather than report them dead.
 */
export function usedExports(cards: readonly FileCard[]): { used: Map<string, Set<string>>; unresolvedNames: Set<string> } {
  const byPath = new Map(cards.map(card => [card.path, card]));
  const used = new Map<string, Set<string>>();
  const unresolvedNames = new Set<string>();
  const use = (path: string, names: Iterable<string>): void => {
    const into = used.get(path) ?? new Set<string>();
    for (const name of names) into.add(name);
    used.set(path, into);
  };
  for (const card of cards) {
    if (!CODE.test(card.path)) continue;
    const mentioned = new Set(card.identifiers);
    for (const { resolved, bindings, isWholeModule, isReexport } of card.imports) {
      const imported = bindings.map(({ imported: name }) => name).filter(name => name !== '*');
      if (resolved == null) { for (const name of imported) unresolvedNames.add(name); continue; }
      if (resolved === card.path) continue;
      use(resolved, imported);
      if (!isWholeModule) continue;
      const target = byPath.get(resolved);
      // `export * from` passes every export on; a namespace or dynamic import reaches the ones this code names.
      use(resolved, (target?.exports ?? []).filter(name => isReexport || mentioned.has(name)));
    }
  }
  return { used, unresolvedNames };
}
