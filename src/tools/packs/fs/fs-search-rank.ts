import type { ContentMatch } from './fs-search-content.js';

/** How much of a search to return: every match line, just the files with their counts, or only the counts. */
export type SearchLayer = 'matches' | 'files' | 'counts';

/** Result order: by path (stable, the default) or by relevance (files defining the text first, then by match count). */
export type SearchOrder = 'path' | 'relevance';

export interface FoundFile {
  path: string;
  count: number;
  matches?: ContentMatch[];
  /** A match line declares the searched name (`function x`, `const x`, `class x`...). */
  defines?: boolean;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a line declares `name`: a declaration keyword (optionally exported) followed by the name itself. */
export function isDefinitionLine(params: { text: string; name: string }): boolean {
  const { text, name } = params;
  return new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var|def)\\s+${escape(name)}\\b`).test(text);
}

/** Marks definitions (plain-text searches only: a regex has no single name) and orders the files as asked. */
export function rankFiles(params: { files: FoundFile[]; pattern: string; regex: boolean; order: SearchOrder; markDefinitions: boolean }): FoundFile[] {
  const { files, pattern, regex, order, markDefinitions } = params;
  // A file may already know it defines the name from all its lines (the kept matches can be a cut-down few).
  const marked = regex || !markDefinitions ? files : files.map(file => (file.defines === true || (file.matches ?? []).some(({ text }) => isDefinitionLine({ text, name: pattern })) ? { ...file, defines: true } : file));
  if (order === 'path') return marked;
  return [...marked].sort((first, second) => Number(second.defines === true) - Number(first.defines === true) || second.count - first.count || (first.path < second.path ? -1 : first.path > second.path ? 1 : 0));
}

/** The files as the layer shows them: match lines kept only in the `matches` layer, nothing per file in `counts`. */
export function filesForLayer(params: { files: FoundFile[]; layer: SearchLayer }): FoundFile[] | undefined {
  const { files, layer } = params;
  if (layer === 'counts') return undefined;
  if (layer === 'files') return files.map(({ matches: _matches, ...rest }) => rest);
  return files;
}
