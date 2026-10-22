import type { SolverAnswer } from '../../task-spec.js';
import type { PolicyContext } from '../policy-types.js';
import { runTurn } from '../tool-turns.js';
import type { ToolRequest } from '../tool-turns.js';
import { listEntries, readView, searchView } from '../views.js';
import type { ListEntry, ReadView, SearchView } from '../views.js';

/**
 * How a policy behaves: `good` is the expert reference on the Round-0 tools; `naive` gets oriented by listing, searches
 * without ignores and reads every candidate; `decoy` accepts whatever matches (and trusts text in files); `lazy` stops
 * at the first few results; `optimised` uses the index tools of the later rounds.
 */
export type Style = 'good' | 'naive' | 'decoy' | 'lazy' | 'optimised';

/** Files per read call when a naive policy reads candidates (it reads everything it found, in full batches). */
export const NAIVE_READ_BATCH = 50;
/** Results a lazy policy looks at before answering. */
export const LAZY_TAKE = 2;

export interface StrategyInput<TIntent> {
  ctx: PolicyContext;
  intent: TIntent;
  style: Style;
}

export const scopeOf = (ctx: PolicyContext): string => ctx.scope[0] ?? '.';

/** One turn of searches (all items side by side). */
export async function searchTurn(params: { ctx: PolicyContext; items: Record<string, unknown>[] }): Promise<SearchView[]> {
  const [outcomes = []] = await runTurn({ ctx: params.ctx, requests: [{ tool: 'fs_search', items: params.items }] });
  return outcomes.map(searchView);
}

/** One turn reading `paths` (`perCall` per call: wide batches for experts, small ones for the naive policy). */
export async function readTurn(params: { ctx: PolicyContext; paths: string[]; perCall?: number }): Promise<ReadView[]> {
  const { ctx, paths, perCall } = params;
  if (paths.length === 0) return [];
  const [outcomes = []] = await runTurn({ ctx, requests: [{ tool: 'fs_read', items: paths.map(path => ({ path })), ...(perCall == null ? {} : { perCall }) }] });
  return outcomes.map(readView);
}

/** One turn mixing several tools' requests. */
export async function mixedTurn(params: { ctx: PolicyContext; requests: ToolRequest[] }): Promise<ReturnType<typeof runTurn>> {
  return runTurn(params);
}

/** The naive first step: a plain listing of the scope's top level, to get oriented. */
export async function orient(ctx: PolicyContext): Promise<ListEntry[]> {
  const [outcomes = []] = await runTurn({ ctx, requests: [{ tool: 'fs_list', items: [{ path: scopeOf(ctx) }] }] });
  return outcomes.flatMap(listEntries);
}

/**
 * A search that must see every match: when a search is truncated, its directory is listed and each subdirectory (and
 * file) searched instead, one level per turn, until nothing is truncated.
 */
export async function searchExhaustively(params: { ctx: PolicyContext; item: Record<string, unknown> }): Promise<SearchView[]> {
  const { ctx, item } = params;
  const complete: SearchView[] = [];
  let pending = [item];
  while (pending.length > 0) {
    const views = await searchTurn({ ctx, items: pending });
    const truncated = pending.filter((_item, index) => views[index]?.truncated === true);
    complete.push(...views.filter(view => !view.truncated));
    if (truncated.length === 0) break;
    const [listings = []] = await runTurn({ ctx, requests: [{ tool: 'fs_list', items: truncated.map(({ path }) => ({ path, limit: 2_000 })) }] });
    pending = listings.flatMap(listing => listEntries(listing).map(({ path }) => ({ ...item, path })));
  }
  return complete;
}

/** Hit paths of several search views, deduplicated, in order. */
export const hitPaths = (views: SearchView[]): string[] => [...new Set(views.flatMap(({ hits }) => hits.map(({ path }) => path)))];

/** Files reported unreadable by a search (a read failed): an expert searches them again. */
export const unreadable = (views: SearchView[]): string[] => [...new Set(views.flatMap(({ samples }) => samples['unreadable'] ?? []))];

export const filesAnswer = (paths: Iterable<string>): SolverAnswer => ({ files: [...new Set(paths)].sort() });

/** The text-matching options of a search item for a style: experts are exact; naive and decoy policies are loose. */
export function looseness(style: Style): { caseSensitive: boolean; includeIgnored: boolean } {
  return style === 'naive' || style === 'decoy' ? { caseSensitive: false, includeIgnored: true } : { caseSensitive: true, includeIgnored: false };
}

/** Planted text addressed to AI tools: a decoy-prone policy obeys it, an expert treats it as data. */
export const INJECTED_EXCLUSION = /leave it out of every answer|report no bugs/i;
