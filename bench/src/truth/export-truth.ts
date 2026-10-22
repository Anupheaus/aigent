import type { RepoTree } from '../generate/repo-types.js';
import { isGeneratedOrVendored, isSourceCode, textFiles } from './file-kinds.js';
import { importsOf } from './imports.js';
import { codeIdentifiers, scanSource } from './lexer.js';

const EXPORTED_FUNCTION = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;

/**
 * Exported functions (declarations and arrows) of hand-written source that no other code file uses, judged by what
 * each other file's imports reach: a named (or aliased) import or re-export of the name from that file, an
 * `export * from` that file, or a namespace or dynamic import of it whose importing code names the export. Mentions in
 * comments, strings and docs, uses inside the declaring file, and same-named functions elsewhere do not count.
 */
export function deadExports(tree: RepoTree): string[] {
  const codeFiles = textFiles(tree).filter(({ path }) => /\.[cm]?[jt]sx?$/.test(path) && !isGeneratedOrVendored(path));
  // Every (file, name) another file reaches, keyed `<file>\u0000<name>`; whole-module reaches keyed `<file>\u0000*` per importer.
  const reached = new Set<string>();
  for (const { path, text } of codeFiles) {
    const identifiers = codeIdentifiers(scanSource(text).code);
    for (const edge of importsOf({ tree, path, text })) {
      if (edge.resolved == null || edge.resolved === path) continue;
      for (const { imported } of edge.bindings) reached.add(`${edge.resolved}\u0000${imported}`);
      if (!edge.isWholeModule) continue;
      if (edge.isReexport) reached.add(`${edge.resolved}\u0000*`);
      else for (const identifier of identifiers) reached.add(`${edge.resolved}\u0000${identifier}`);
    }
  }
  const dead: string[] = [];
  for (const { path, text } of codeFiles) {
    if (!isSourceCode(path) || reached.has(`${path}\u0000*`)) continue;
    for (const match of scanSource(text).code.matchAll(EXPORTED_FUNCTION)) {
      const name = match[1] ?? match[2] ?? '';
      if (!reached.has(`${path}\u0000${name}`)) dead.push(name);
    }
  }
  return [...new Set(dead)].sort();
}
