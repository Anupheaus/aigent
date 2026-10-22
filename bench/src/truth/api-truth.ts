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

/** Every route registered on a router that some source file mounts with `.use(router)`. */
export function liveRoutes(tree: RepoTree): LiveRoute[] {
  const sources = textFiles(tree).filter(({ path }) => isSourceCode(path)).map(file => ({ ...file, code: scanSource(file.text).code }));
  const mounted = new Set(sources.flatMap(({ code }) => [...code.matchAll(/\.use\(\s*(\w+)\s*\)/g)].map(match => match[1] ?? '')));
  const routes: LiveRoute[] = [];
  for (const { path, text, code } of sources) {
    for (const declared of code.matchAll(/export\s+const\s+(\w+)\s*=\s*createRouter\(\)/g)) {
      const router = declared[1] ?? '';
      if (!mounted.has(router)) continue;
      // Find each call in code (so commented-out lines are skipped), then read its path from the original text.
      for (const call of code.matchAll(new RegExp(`\\b${router}\\.(?:get|post|put|patch|delete)\\(`, 'g'))) {
        ROUTE_CALL.lastIndex = call.index ?? 0;
        const parsed = ROUTE_CALL.exec(text);
        if (parsed == null) continue;
        routes.push({ method: (parsed[2] ?? '').toUpperCase(), path: parsed[3] ?? '', routerFile: path, handlerName: parsed[4] ?? '' });
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
