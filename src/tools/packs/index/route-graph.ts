import type { FileCard, LiveRoute } from './index-types.js';

/** A router as a declared variable: `<file>\u0000<name>`. */
type RouterKey = string;

/** How far re-export chains (`export { x } from './y'`) are followed when a name is resolved. */
const MAX_REEXPORT_HOPS = 8;
/** Mount prefixes kept per router (a router mounted at many paths). */
const MAX_PREFIXES = 16;
const keyOf = (path: string, name: string): RouterKey => `${path}\u0000${name}`;

/** The served path of `path` mounted under `prefix` (`/api` + `/users` = `/api/users`; `/api` + `/` = `/api`). */
export function joinRoutePath(params: { prefix: string; path: string }): string {
  const { prefix, path } = params;
  const head = prefix.replace(/\/+$/, '');
  const tail = path === '/' && head !== '' ? '' : path;
  const joined = `${head}${tail.startsWith('/') || tail === '' ? '' : '/'}${tail}`;
  return joined === '' ? '/' : joined;
}

/**
 * The router variable a name in `file` denotes: a router declared there, or one it imports (aliases, default
 * exports and re-export chains followed through the resolved imports). Undefined when it is not a router.
 */
function resolveRouter(params: { byPath: ReadonlyMap<string, FileCard>; file: FileCard; name: string }): RouterKey | undefined {
  const { byPath } = params;
  let { file, name } = params;
  for (let hop = 0; hop <= MAX_REEXPORT_HOPS; hop += 1) {
    if (file.routers.includes(name)) return keyOf(file.path, name);
    // An exported name may be the default export of a local router.
    if (name === 'default' && file.defaultExport != null && file.routers.includes(file.defaultExport)) return keyOf(file.path, file.defaultExport);
    const current = file;
    const local = name;
    const via = current.imports.find(({ bindings, resolved }) => resolved != null && bindings.some(binding => binding.local === local));
    const binding = via?.bindings.find(entry => entry.local === local);
    const target = via?.resolved == null ? undefined : byPath.get(via.resolved);
    if (target == null || binding == null || binding.imported === '*') return undefined;
    file = target;
    name = binding.imported;
  }
  return undefined;
}

/** Whether `receiver` in `file` is an application: not a router, but something that mounts (`app.use(...)`). */
const isApp = (params: { file: FileCard; receiver: string }): boolean => params.file.mounts.some(({ receiver }) => receiver === params.receiver);

/**
 * Every served route by file: routes registered on a router that an application reaches through `.use` mounts
 * (directly, at a path, behind middleware or through other mounted routers), with the mount prefixes joined, plus
 * routes registered on an application itself. Names are resolved through each file's own imports, so an unmounted
 * router that shares a mounted one's name is never live.
 */
export function liveRoutesByFile(params: { cards: FileCard[]; byPath: ReadonlyMap<string, FileCard> }): Map<string, LiveRoute[]> {
  const { cards, byPath } = params;
  const edges: { parent?: RouterKey; child: RouterKey; prefix: string }[] = [];
  for (const file of cards) {
    for (const { receiver, path, routers } of file.mounts) {
      const parent = resolveRouter({ byPath, file, name: receiver });
      for (const name of routers) {
        const child = resolveRouter({ byPath, file, name });
        if (child != null) edges.push({ ...(parent == null ? {} : { parent }), child, prefix: path });
      }
    }
  }
  // Prefixes reach routers from the applications (no parent router) outwards, until nothing changes.
  const prefixes = new Map<RouterKey, Set<string>>();
  for (let changed = true; changed;) {
    changed = false;
    for (const { parent, child, prefix } of edges) {
      const from = parent == null ? [''] : [...(prefixes.get(parent) ?? [])];
      const into = prefixes.get(child) ?? new Set<string>();
      for (const base of from) {
        const joined = base === '' ? prefix : joinRoutePath({ prefix: base, path: prefix });
        if (into.size < MAX_PREFIXES && !into.has(joined)) { into.add(joined); changed = true; }
      }
      prefixes.set(child, into);
    }
  }
  const live = new Map<string, LiveRoute[]>();
  for (const file of cards) {
    const served = file.routes.flatMap(route => {
      const key = resolveRouter({ byPath, file, name: route.router });
      const bases = key == null ? (isApp({ file, receiver: route.router }) ? [''] : []) : [...(prefixes.get(key) ?? [])];
      return bases.map(base => ({ method: route.method, path: base === '' ? route.path : joinRoutePath({ prefix: base, path: route.path }), registeredPath: route.path, router: route.router, handler: route.handler }));
    });
    live.set(file.path, served);
  }
  return live;
}
