import type { RepoTree } from '../generate/repo-types.js';
import { isGeneratedOrVendored, isSourceCode, textFiles } from './file-kinds.js';
import { codeIdentifiers, scanSource } from './lexer.js';

const EXPORTED_FUNCTION = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;

/**
 * Exported functions (declarations and arrows) of hand-written source that no other code file references: not imported,
 * re-exported, called through a dynamic import or used by a test. Mentions in comments, strings and docs do not count.
 */
export function deadExports(tree: RepoTree): string[] {
  const codeFiles = textFiles(tree).filter(({ path }) => /\.[cm]?[jt]sx?$/.test(path) && !isGeneratedOrVendored(path)).map(({ path, text }) => {
    const { code } = scanSource(text);
    return { path, code, identifiers: codeIdentifiers(code) };
  });
  // How many code files mention each identifier: a declaration's own file is one, so 1 means nobody else uses it.
  const filesMentioning = new Map<string, number>();
  for (const { identifiers } of codeFiles) for (const identifier of identifiers) filesMentioning.set(identifier, (filesMentioning.get(identifier) ?? 0) + 1);
  const dead: string[] = [];
  for (const { path, code } of codeFiles) {
    if (!isSourceCode(path)) continue;
    for (const match of code.matchAll(EXPORTED_FUNCTION)) {
      const name = match[1] ?? match[2] ?? '';
      if ((filesMentioning.get(name) ?? 0) <= 1) dead.push(name);
    }
  }
  return [...new Set(dead)].sort();
}
