import type { Manifest } from '../generate/repo-types.js';
import type { TaskSpec } from '../task-spec.js';

/** Shortest path segment (or segment substring) treated as a hint when it appears in task text. */
export const MIN_HINT_CHARS = 6;
/** Shortest answer directory name a given term may not contain. */
const MIN_GIVEN_DIR_CHARS = 4;
/** A scope entry must hold planted material of at least this many families (or be the repo root). */
const MIN_SCOPE_FAMILIES = 3;

export type LintKind = 'answer-path' | 'path-segment' | 'segment-substring' | 'distinctive' | 'scope' | 'given-term';

export interface LintIssue {
  /** Which input leaked (`prompt`, `scope[0]`, `context`, `persona`...). */
  field: string;
  kind: LintKind;
  /** The leaked term. */
  term: string;
  message: string;
}

/** What must never reach a solver: answer paths and the distinctive strings around them. */
export interface HintSources {
  paths: string[];
  distinctive: string[];
}

const normalise = (text: string): string => text.replace(/\\/g, '/').toLowerCase();

/** Answer paths and distinctive strings of one spec: its ground truth and the manifest's needles for its query. */
export function hintSourcesOf(params: { spec: TaskSpec; manifest: Manifest }): HintSources {
  const { spec: { groundTruth, query }, manifest } = params;
  const needles = manifest.items.filter(({ answers = [] }) => answers.includes(query));
  const truthPaths = groundTruth.kind === 'files' ? [...groundTruth.files, ...(groundTruth.alternatives ?? []).flat()] : groundTruth.kind === 'bugs' ? groundTruth.bugs.map(({ path }) => path) : [];
  const criteria = groundTruth.kind === 'criteria' ? groundTruth.required : [];
  return { paths: [...new Set([...truthPaths, ...needles.map(({ path }) => path)])], distinctive: [...new Set([...criteria, ...needles.flatMap(({ distinctive = [] }) => distinctive)])] };
}

/** Every answer of every query in the manifest: what agent persona, skillset and context must not mention. */
export function allHintSources(manifest: Manifest): HintSources {
  const needles = manifest.items.filter(({ kind }) => kind === 'needle');
  const criteria = Object.values(manifest.criteria).flatMap(({ required }) => required);
  return { paths: [...new Set(needles.map(({ path }) => path))], distinctive: [...new Set([...criteria, ...needles.flatMap(({ distinctive = [] }) => distinctive)])] };
}

/** Path segments worth checking: directory names and file names with and without their extension. */
function segmentsOf(path: string): string[] {
  return path.split('/').flatMap(segment => [segment, segment.replace(/\.[^.]+$/, ''), segment.replace(/\..*$/, '')]).filter((segment, position, all) => segment !== '' && all.indexOf(segment) === position);
}

/** Checks one text against the hint sources; `givenTerms` (the user's own question) are masked out first. */
export function lintText(params: { field: string; text: string; sources: HintSources; givenTerms?: string[] }): LintIssue[] {
  const { field, text, sources, givenTerms = [] } = params;
  let masked = normalise(text);
  for (const term of [...givenTerms].sort((first, second) => second.length - first.length)) masked = masked.split(normalise(term)).join(' ');
  const issues: LintIssue[] = [];
  const issue = (kind: LintKind, term: string, message: string): void => { if (!issues.some(existing => existing.kind === kind && existing.term === term)) issues.push({ field, kind, term, message: `${field}: ${message}` }); };
  for (const path of sources.paths) {
    if (masked.includes(normalise(path))) { issue('answer-path', path, `names the answer path '${path}'`); continue; }
    for (const segment of segmentsOf(path)) {
      const lower = normalise(segment);
      if (lower.length >= MIN_HINT_CHARS && masked.includes(lower)) { issue('path-segment', segment, `names '${segment}', a segment of the answer path '${path}'`); continue; }
      for (let start = 0; start + MIN_HINT_CHARS <= lower.length; start += 1) {
        const window = lower.slice(start, start + MIN_HINT_CHARS);
        if (masked.includes(window)) { issue('segment-substring', window, `contains '${window}', part of the answer path segment '${segment}' (${path})`); break; }
      }
    }
  }
  for (const term of sources.distinctive) {
    if (masked.includes(normalise(term))) issue('distinctive', term, `contains the distinctive answer string '${term}'`);
  }
  return issues;
}

/** Given terms are the user's question (a file name, an identifier, an endpoint): never an answer path or folder. */
function lintGivenTerms(params: { givenTerms: string[]; sources: HintSources }): LintIssue[] {
  const { givenTerms, sources } = params;
  const directories = [...new Set(sources.paths.flatMap(path => path.split('/').slice(0, -1)))].filter(directory => directory.length >= MIN_GIVEN_DIR_CHARS);
  return givenTerms.flatMap(term => {
    const lower = normalise(term);
    // Words of the term (camelCase, separators, slashes): a folder leaks only as a whole word, not inside one ("Score").
    const words = new Set(term.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(word => word !== ''));
    const leaked = [...sources.paths.filter(path => lower.includes(normalise(path))), ...directories.filter(directory => words.has(normalise(directory)) || (directory.includes('-') && lower.includes(normalise(directory))))];
    return leaked.map(leak => ({ field: 'givenTerms', kind: 'given-term' as const, term: leak, message: `givenTerms: '${term}' contains '${leak}' from an answer path` }));
  });
}

/** A scope entry must be the repo root or a top-level area holding planted material of several families. */
function lintScope(params: { scope: string[]; manifest: Manifest; sources: HintSources }): LintIssue[] {
  const { scope, manifest, sources } = params;
  return scope.flatMap((entry, position): LintIssue[] => {
    const area = entry.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '');
    if (area === '') return [];
    const field = `scope[${position}]`;
    if (area.includes('/')) return [{ field, kind: 'scope', term: entry, message: `${field}: '${entry}' is not the root or a top-level area` }];
    const families = new Set(manifest.items.filter(({ path }) => path.startsWith(`${area}/`)).map(({ family }) => family));
    const holdsAll = sources.paths.every(path => path.startsWith(`${area}/`));
    if (families.size < MIN_SCOPE_FAMILIES) return [{ field, kind: 'scope', term: entry, message: `${field}: '${entry}' holds material of ${families.size} families (expected at least ${MIN_SCOPE_FAMILIES})` }];
    return holdsAll || sources.paths.length === 0 ? [] : [{ field, kind: 'scope', term: entry, message: `${field}: '${entry}' leaves answers outside the scope` }];
  });
}

/**
 * Lints a task: no answer path, path segment (or a 6-character piece of one), symbol or distinctive string may appear in
 * the prompt, scope or context (case and separator variants included); given terms may not carry answer folders; and
 * scope entries must be broad.
 */
export function lintTask(spec: TaskSpec, manifest: Manifest): LintIssue[] {
  const sources = hintSourcesOf({ spec, manifest });
  const { prompt, scope, context, givenTerms } = spec;
  return [
    ...lintText({ field: 'prompt', text: prompt, sources, givenTerms }),
    ...scope.flatMap((entry, position) => lintText({ field: `scope[${position}]`, text: entry, sources })),
    ...(context == null ? [] : lintText({ field: 'context', text: context, sources, givenTerms })),
    ...lintGivenTerms({ givenTerms, sources }),
    ...lintScope({ scope, manifest, sources }),
  ];
}

/** Lints the bench agents' persona, skillset and context against every answer of the repository. */
export function lintAgentTexts(params: { texts: Record<string, string>; manifest: Manifest }): LintIssue[] {
  const { texts, manifest } = params;
  const sources = allHintSources(manifest);
  return Object.entries(texts).flatMap(([field, text]) => lintText({ field, text, sources }));
}
