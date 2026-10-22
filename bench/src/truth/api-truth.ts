import type { RepoTree } from '../generate/repo-types.js';
import { isSourceCode, textFiles } from './file-kinds.js';
import { importsOf } from './imports.js';
import { scanSource } from './lexer.js';

/** A live route: where it is registered and the handler it names. */
export interface LiveRoute {
  method: string;
  path: string;
  routerFile: string;
  handlerName: string;
}

const ROUTE_CALL = /\b(\w+)\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,\s*(\w+)\s*\)/y;

/** `x.use(router)` or `x.use('/prefix', router)` (the generator's mounts, and the common Express path mount). */
const USE_CALL = /\.use\(\s*(?:'([^']*)'\s*,\s*)?(\w+)\s*\)/y;

/**
 * Where each mount points: the mounted name resolved through the mounting file's own imports (the exporting file and
 * name), or the mounting file itself when the name is declared there; with the mount's path prefix.
 */
function mountedRouters(params: { tree: RepoTree; sources: { path: string; text: string; code: string }[] }): Map<string, string[]> {
  const { tree, sources } = params;
  const prefixes = new Map<string, string[]>();
  for (const { path, text, code } of sources) {
    const edges = importsOf({ tree, path, text });
    for (const call of code.matchAll(/\.use\(/g)) {
      USE_CALL.lastIndex = call.index ?? 0;
      const parsed = USE_CALL.exec(text);
      if (parsed == null) continue;
      const name = parsed[2] ?? '';
      const edge = edges.find(({ bindings }) => bindings.some(({ local }) => local === name));
      const binding = edge?.bindings.find(({ local }) => local === name);
      const key = edge == null ? `${path}\u0000${name}` : edge.resolved == null || binding == null ? undefined : `${edge.resolved}\u0000${binding.imported}`;
      if (key != null) prefixes.set(key, [...(prefixes.get(key) ?? []), parsed[1] ?? '']);
    }
  }
  return prefixes;
}

/** Every route registered on a router that some source file mounts (`.use(router)`, `.use('/prefix', router)`), resolved through imports. */
export function liveRoutes(tree: RepoTree): LiveRoute[] {
  const sources = textFiles(tree).filter(({ path }) => isSourceCode(path)).map(file => ({ ...file, code: scanSource(file.text).code }));
  const mounted = mountedRouters({ tree, sources });
  const routes: LiveRoute[] = [];
  for (const { path, text, code } of sources) {
    for (const declared of code.matchAll(/export\s+const\s+(\w+)\s*=\s*createRouter\(\)/g)) {
      const router = declared[1] ?? '';
      for (const prefix of mounted.get(`${path}\u0000${router}`) ?? []) {
        // Find each call in code (so commented-out lines are skipped), then read its path from the original text.
        for (const call of code.matchAll(new RegExp(`\\b${router}\\.(?:get|post|put|patch|delete)\\(`, 'g'))) {
          ROUTE_CALL.lastIndex = call.index ?? 0;
          const parsed = ROUTE_CALL.exec(text);
          if (parsed == null) continue;
          routes.push({ method: (parsed[2] ?? '').toUpperCase(), path: `${prefix.replace(/\/$/, '')}${parsed[3] ?? ''}`, routerFile: path, handlerName: parsed[4] ?? '' });
        }
      }
    }
  }
  return routes.sort((first, second) => `${first.method} ${first.path}`.localeCompare(`${second.method} ${second.path}`));
}

/** `METHOD /path` of every live route. */
export function liveEndpoints(tree: RepoTree): string[] {
  return [...new Set(liveRoutes(tree).map(({ method, path }) => `${method} ${path}`))].sort();
}

/** The files a request passes through: the router registering it, its handler, and the module running its query. */
export function traceRoute(params: { tree: RepoTree; endpoint: string }): string[] {
  const { tree, endpoint } = params;
  const route = liveRoutes(tree).find(({ method, path }) => `${method} ${path}` === endpoint);
  if (route == null) return [];
  const routerText = tree.get(route.routerFile);
  if (typeof routerText !== 'string') return [];
  const handlerFile = importsOf({ tree, path: route.routerFile, text: routerText }).find(({ names }) => names.includes(route.handlerName))?.resolved;
  const handlerText = handlerFile == null ? undefined : tree.get(handlerFile);
  if (handlerFile == null || typeof handlerText !== 'string') return [route.routerFile];
  const handlerCode = scanSource(handlerText).code;
  const dataFiles = importsOf({ tree, path: handlerFile, text: handlerText }).flatMap(({ names, resolved }) => {
    const called = names.some(name => new RegExp(`\\b${name}\\s*\\(`).test(handlerCode));
    const target = resolved == null ? undefined : tree.get(resolved);
    return called && resolved != null && typeof target === 'string' && /\bdb\.query\(/.test(scanSource(target).code) ? [resolved] : [];
  });
  return [...new Set([route.routerFile, handlerFile, ...dataFiles])].sort();
}
