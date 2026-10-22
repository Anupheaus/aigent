import type { SolverAnswer } from '../../task-spec.js';
import { reviewFile, RISK_PATTERNS } from '../judge/bugs.js';
import { baseName, isBuildOrVendor, isOwnCode, resolveImport } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import type { Intent } from '../read-prompt.js';
import { runTurn } from '../tool-turns.js';
import { searchView } from '../views.js';
import { readTurn, scopeOf } from './shared.js';

/** Which optimisation round's behaviour to play (each round keeps the earlier rounds' changes). */
export type OptimisedRound = 1 | 2 | 3;

const WIDE = 500;
const TEST_TAGS = ['test', 'story', 'mock'];
const wordsOf = (identifier: string): string[] => identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/).filter(word => word !== '');
const sorted = (paths: Iterable<string>): SolverAnswer => ({ files: [...new Set(paths)].sort() });

/** One turn of `tool` items; each item's result object. */
async function ask(params: { ctx: PolicyContext; tool: string; items: Record<string, unknown>[] }): Promise<Record<string, unknown>[]> {
  const [outcomes = []] = await runTurn({ ctx: params.ctx, requests: [{ tool: params.tool, items: params.items }] });
  return outcomes.map(({ result = {} }) => result);
}

const filesOf = (result: Record<string, unknown> | undefined): { path: string; tags?: string[]; importers?: number; routes?: string[]; unusedExports?: string[] }[] =>
  (Array.isArray(result?.['files']) ? result['files'] : Array.isArray(result?.['cards']) ? result['cards'] : []) as { path: string }[];

/** Round 1: the improved `fs_search` (files layer) where the match lines were never needed. */
async function roundOne(params: { ctx: PolicyContext; intent: Intent }): Promise<SolverAnswer | undefined> {
  const { ctx, intent } = params;
  const scope = scopeOf(ctx);
  const search = async (items: Record<string, unknown>[]) => (await runTurn({ ctx, requests: [{ tool: 'fs_search', items: items.map(item => ({ path: scope, kind: 'content', layer: 'files', ...item })) }] }))[0]?.map(searchView) ?? [];
  const paths = (view: { hits: { path: string }[] } | undefined): string[] => (view?.hits ?? []).map(({ path }) => path);
  switch (intent.kind) {
    case 'string-any-case': return sorted(paths((await search([{ pattern: wordsOf(intent.identifier).join('[_-]?'), regex: true }]))[0]).filter(path => !isBuildOrVendor(path)));
    case 'string-word': return sorted(paths((await search([{ pattern: intent.identifier, wholeWord: true, caseSensitive: true }]))[0]).filter(path => !isBuildOrVendor(path)));
    case 'string-noisy': {
      const [importers, callers] = await search([{ pattern: `import \\{[^}]*\\b${intent.verb}\\b[^}]*\\} from '[^']*analytics'`, regex: true, caseSensitive: true }, { pattern: `\\b${intent.verb}\\(`, regex: true, caseSensitive: true }]);
      const calling = new Set(paths(callers));
      return sorted(paths(importers).filter(path => calling.has(path) && isOwnCode(path)));
    }
    case 'pii-fields': return sorted(paths((await search([{ pattern: '^\\s*(fullName|firstName|lastName|email|phone|phoneNumber|address|postalAddress|dateOfBirth|nationalId)\\??:\\s*(string|number|boolean|Date|z\\.)', regex: true, caseSensitive: true }]))[0]).filter(isOwnCode));
    case 'ui-customer': return sorted(paths((await search([{ pattern: '\\{[^}]*\\.(fullName|firstName|lastName|email|phone|phoneNumber|address|postalAddress|dateOfBirth|nationalId)\\b', regex: true, caseSensitive: true, glob: '**/*.tsx' }]))[0]).filter(isOwnCode));
    default: return undefined;
  }
}

/** Round 2: index lookups for classification and structure questions. */
async function roundTwo(params: { ctx: PolicyContext; intent: Intent }): Promise<SolverAnswer | undefined> {
  const { ctx, intent } = params;
  const tagged = async (tags: string[]) => filesOf((await ask({ ctx, tool: 'repo_tags', items: [{ tags, limit: WIDE }] }))[0]);
  switch (intent.kind) {
    case 'react': return sorted((await tagged(['react-component'])).map(({ path }) => path));
    case 'ui-customer': return sorted((await tagged(['renders-customer-data'])).map(({ path }) => path));
    case 'pii-fields': return sorted((await tagged(['personal-data-fields'])).map(({ path }) => path));
    case 'gdpr': return sorted((await tagged(['gdpr-consent', 'gdpr-deletion', 'gdpr-export', 'gdpr-retention'])).filter(({ tags = [] }) => tags.includes('api-handler')).map(({ path }) => path));
    case 'theme': return sorted((await tagged(['theme-definition'])).filter(({ importers = 0 }) => importers > 0).map(({ path }) => path));
    case 'endpoints': return { text: [...new Set((await tagged(['api-route'])).flatMap(({ routes = [] }) => routes))].sort().join('\n') };
    case 'dead-exports': return { text: filesOf((await ask({ ctx, tool: 'repo_find', items: [{ unusedExports: true, limit: WIDE }] }))[0]).flatMap(({ unusedExports = [] }) => unusedExports).sort().join('\n') };
    case 'route-trace': {
      const [result] = await ask({ ctx, tool: 'repo_find', items: [{ route: intent.endpoint }] });
      const [registration] = (result?.['registrations'] ?? []) as { registeredIn: string; handlerFile?: string; callees: { path: string; tags: string[] }[] }[];
      if (registration == null) return { files: [] };
      return sorted([registration.registeredIn, ...(registration.handlerFile == null ? [] : [registration.handlerFile]), ...registration.callees.filter(({ tags }) => tags.includes('data-access')).map(({ path }) => path)]);
    }
    default: return undefined;
  }
}

/** Round 3: layered answers (`search_layers`, files layer, code only, test kinds excluded) for every search question. */
async function roundThree(params: { ctx: PolicyContext; intent: Intent }): Promise<SolverAnswer | undefined> {
  const { ctx, intent } = params;
  const layered = async (items: Record<string, unknown>[]) => (await ask({ ctx, tool: 'search_layers', items: items.map(item => ({ layer: 'files', limit: WIDE, ...item })) })).map(result => filesOf(result).map(({ path }) => path));
  const usage = async (identifier: string, excludeTags: string[]) => sorted((await layered([{ pattern: identifier, wholeWord: true, where: 'code', excludeTags }]))[0] ?? []);
  switch (intent.kind) {
    case 'find-file': {
      const exact = filesOf((await ask({ ctx, tool: 'repo_find', items: [{ name: intent.name, limit: 5 }] }))[0]).filter(({ path }) => baseName(path) === intent.name).map(({ path }) => path);
      return exact.length === 0 ? { none: true } : sorted(exact);
    }
    case 'tests-for': return testsForByIndex({ ctx, module: intent.module });
    case 'bugs': return bugsByIndex(ctx);
    case 'string-usage': return usage(intent.identifier, TEST_TAGS);
    case 'env-var': return usage(intent.name, TEST_TAGS);
    case 'symbol': return usage(intent.name, ['mock']);
    case 'string-any-case': return sorted((await layered([{ pattern: wordsOf(intent.identifier).join('[_-]?'), regex: true, caseSensitive: false }]))[0] ?? []);
    case 'string-word': return sorted((await layered([{ pattern: intent.identifier, wholeWord: true }]))[0] ?? []);
    case 'string-noisy': {
      const [importers = [], callers = []] = await layered([{ pattern: `import \\{[^}]*\\b${intent.verb}\\b[^}]*\\} from '[^']*analytics'`, regex: true, excludeTags: TEST_TAGS }, { pattern: `\\b${intent.verb}\\(`, regex: true, where: 'code' }]);
      return sorted(importers.filter(path => callers.includes(path)));
    }
    default: return undefined;
  }
}

/** Tests of a module in one turn: the module by name, and test snippets importing a path ending in its stem. */
async function testsForByIndex(params: { ctx: PolicyContext; module: string }): Promise<SolverAnswer> {
  const { ctx, module } = params;
  const stem = module.replace(/\.[^.]+$/, '');
  const [found = [], importing = []] = await runTurn({ ctx, requests: [
    { tool: 'repo_find', items: [{ name: module, limit: 5 }] },
    { tool: 'search_layers', items: [{ pattern: `from '[^']*/${stem}'`, regex: true, layer: 'snippets', tags: ['test'], limit: WIDE }] },
  ] });
  const target = filesOf(found[0]?.result).map(({ path }) => path).find(path => baseName(path) === module)?.replace(/\.[^.]+$/, '');
  const snippets = (importing[0]?.result?.['files'] ?? []) as { path: string; lines?: { text: string }[] }[];
  return sorted(snippets.filter(({ path, lines = [] }) => lines.some(({ text }) => {
    const specifier = /from '([^']+)'/.exec(text)?.[1];
    return specifier != null && resolveImport({ from: path, specifier, known: () => true }) === target;
  })).map(({ path }) => path));
}

/** The bug review with the index: every risk search at the files layer in one turn, then one read of the hit files. */
async function bugsByIndex(ctx: PolicyContext): Promise<SolverAnswer> {
  const hits = (await ask({ ctx, tool: 'search_layers', items: RISK_PATTERNS.map(pattern => ({ pattern, regex: true, layer: 'files', excludeTags: TEST_TAGS, limit: WIDE })) })).flatMap(result => filesOf(result).map(({ path }) => path));
  const reads = await readTurn({ ctx, paths: [...new Set(hits)].filter(isOwnCode) });
  return { bugs: reads.flatMap(({ path, text }) => reviewFile(text).map(bug => ({ path, ...bug }))) };
}

/** The optimised policy's answer for `intent` in `round`, or undefined to fall back to the reference strategy. */
export async function solveOptimised(params: { ctx: PolicyContext; intent: Intent; round: OptimisedRound }): Promise<SolverAnswer | undefined> {
  const { ctx, intent, round } = params;
  if (round >= 3) { const answer = await roundThree({ ctx, intent }); if (answer != null) return answer; }
  if (round >= 2) { const answer = await roundTwo({ ctx, intent }); if (answer != null) return answer; }
  return roundOne({ ctx, intent });
}
