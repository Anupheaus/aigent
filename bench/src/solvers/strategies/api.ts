import type { SolverAnswer } from '../../task-spec.js';
import { codeOfLine } from '../judge/code-lines.js';
import { isOwnCode, resolveImport } from '../judge/paths.js';
import type { PolicyContext } from '../policy-types.js';
import type { SearchView } from '../views.js';
import { filesAnswer, hitPaths, LAZY_TAKE, NAIVE_READ_BATCH, orient, readTurn, scopeOf, searchTurn } from './shared.js';
import type { Style } from './shared.js';

const REGISTRATION = /(\w+)\.(get|post|put|patch|delete)\('([^']*)',\s*(\w+)\)/;
const MOUNT = /\.use\((\w+)\)/;

/** Routers some own code mounts with `.use(...)`. */
const mountedRouters = (view: SearchView | undefined): Set<string> => new Set((view?.hits ?? []).filter(({ path }) => isOwnCode(path)).flatMap(({ matches }) => matches.flatMap(({ text }) => MOUNT.exec(codeOfLine(text))?.[1] ?? [])));

/** Live registrations: own code, not commented out, on a mounted router. */
function liveRegistrations(params: { registrations: SearchView | undefined; mounts: SearchView | undefined }): { path: string; method: string; route: string; handler: string }[] {
  const { registrations, mounts } = params;
  const mounted = mountedRouters(mounts);
  return (registrations?.hits ?? []).filter(({ path }) => isOwnCode(path)).flatMap(({ path, matches }) => matches.flatMap(({ text }) => {
    if (codeOfLine(text).trim() === '') return [];
    const parsed = REGISTRATION.exec(text);
    if (parsed == null || !mounted.has(parsed[1] ?? '')) return [];
    return [{ path, method: (parsed[2] ?? '').toUpperCase(), route: parsed[3] ?? '', handler: parsed[4] ?? '' }];
  }));
}

const registrationItems = (scope: string): Record<string, unknown>[] => [
  { path: scope, pattern: "\\.(get|post|put|patch|delete)\\('", regex: true, caseSensitive: true, kind: 'content', maxMatches: 500 },
  { path: scope, pattern: '.use(', caseSensitive: true, kind: 'content', maxMatches: 100 },
];

/**
 * Every live endpoint. Expert: one turn searching registrations and mounts, judged line by line. Naive: oriented, it
 * reads every file with a registration first. Decoy: every registration-looking line, live or not. Lazy: the first few.
 */
export async function solveEndpoints(params: { ctx: PolicyContext; style: Style }): Promise<SolverAnswer> {
  const { ctx, style } = params;
  if (style === 'naive') await orient(ctx);
  const [registrations, mounts] = await searchTurn({ ctx, items: registrationItems(scopeOf(ctx)) });
  if (style === 'decoy') return { text: (registrations?.hits ?? []).flatMap(({ matches }) => matches.flatMap(({ text }) => { const parsed = REGISTRATION.exec(text); return parsed == null ? [] : [`${(parsed[2] ?? '').toUpperCase()} ${parsed[3]}`]; })).join('\n') };
  if (style === 'naive') await readTurn({ ctx, paths: hitPaths(registrations ? [registrations] : []).filter(isOwnCode), perCall: NAIVE_READ_BATCH });
  const live = liveRegistrations({ registrations, mounts }).map(({ method, route }) => `${method} ${route}`);
  return { text: [...new Set(style === 'lazy' ? live.slice(0, LAZY_TAKE) : live)].sort().join('\n') };
}

/**
 * The files one request passes through. Expert: find the live registration, read the router for the handler's import,
 * read the handler for its data import, read that to confirm the query. Naive: oriented, reads every router-ish file.
 * Decoy: every file naming the route or the handler. Lazy: the router alone.
 */
export async function solveRouteTrace(params: { ctx: PolicyContext; endpoint: string; style: Style }): Promise<SolverAnswer> {
  const { ctx, endpoint, style } = params;
  const scope = scopeOf(ctx);
  const [method = '', route = ''] = endpoint.split(/\s+/);
  if (style === 'naive') await orient(ctx);
  const [registrations, mounts, mentions] = await searchTurn({ ctx, items: [...registrationItems(scope), { path: scope, pattern: `'${route}'`, kind: 'content', caseSensitive: true, includeIgnored: style !== 'good' }] });
  if (style === 'decoy') return filesAnswer(hitPaths(mentions ? [mentions] : []));
  const registration = liveRegistrations({ registrations, mounts }).find(entry => entry.method === method.toUpperCase() && entry.route === route);
  if (registration == null) return { files: [] };
  if (style === 'lazy') return filesAnswer([registration.path]);
  if (style === 'naive') await readTurn({ ctx, paths: hitPaths(mentions ? [mentions] : []), perCall: NAIVE_READ_BATCH });
  const [router] = await readTurn({ ctx, paths: [registration.path] });
  const [handler] = importsNaming({ from: registration.path, text: router?.text ?? '', wanted: names => names.includes(registration.handler) });
  if (handler == null) return filesAnswer([registration.path]);
  const [handlerRead] = await readTurn({ ctx, paths: [handler] });
  const handlerText = handlerRead?.text ?? '';
  const called = (names: string[]): boolean => names.some(name => new RegExp(`\\b${name}\\(`).test(handlerText.split('\n').filter(line => !line.startsWith('import')).join('\n')));
  const dataFiles = importsNaming({ from: handler, text: handlerText, wanted: called });
  const confirmed = (await readTurn({ ctx, paths: dataFiles })).filter(({ ok, text }) => ok && /db\.query\(/.test(text)).map(({ path }) => path);
  return filesAnswer([registration.path, handler, ...confirmed]);
}

/** The `.ts` files a source imports names from, when those names satisfy `wanted`. */
function importsNaming(params: { from: string; text: string; wanted: (names: string[]) => boolean }): string[] {
  const { from, text, wanted } = params;
  return text.split('\n').flatMap(line => {
    const imported = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/.exec(line);
    if (imported == null || !wanted((imported[1] ?? '').split(',').map(part => part.trim()))) return [];
    const resolved = resolveImport({ from, specifier: imported[2] ?? '', known: () => true });
    return resolved == null ? [] : [`${resolved}.ts`];
  });
}
