import type { PlantContext, RouteSpec } from '../plant-context.js';
import { markdownDoc } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { relativeImport } from '../paths.js';
import { pascal } from '../vocabulary.js';
import { routerFileOf } from '../wiring.js';

const TRACE = 'route-trace';
const ENDPOINTS = 'endpoints';
const OPERATIONS: readonly { verb: string; method: RouteSpec['method']; suffix: string; sql: string }[] = [
  { verb: 'load', method: 'GET', suffix: '/:id', sql: 'SELECT * FROM {table} WHERE id = $1' },
  { verb: 'list', method: 'GET', suffix: '', sql: 'SELECT * FROM {table} LIMIT 50' },
  { verb: 'update', method: 'PATCH', suffix: '/:id', sql: 'UPDATE {table} SET data = $2 WHERE id = $1' },
];

const handlerSource = (params: { name: string; path: string; repoFn: string; repoPath: string }): string => lines(
  `import type { ApiRequest, ApiResponse } from '${relativeImport({ from: params.path, to: 'src/server/http.ts' })}';`,
  `import { ${params.repoFn} } from '${relativeImport({ from: params.path, to: params.repoPath })}';`,
  '',
  `export async function ${params.name}(request: ApiRequest): Promise<ApiResponse> {`,
  `  const rows = await ${params.repoFn}(request.params.id ?? '');`,
  '  return { status: 200, body: rows };',
  '}',
);

/** One resource: a repository file and a handler per operation, registered under the group's router. */
function plantResource(params: { ctx: PlantContext; group: string }): { routes: { route: RouteSpec; repoPath: string }[] } {
  const { ctx, group } = params;
  const table = ctx.freshWord();
  const repoPath = `src/server/data/${ctx.freshWord()}-repo.ts`;
  const handlerDir = `src/server/api/${ctx.freshWord()}`;
  const routeBase = `/api/${table}s`;
  const repoFns = OPERATIONS.map(({ verb }) => `${verb}${pascal(table)}Rows`);
  ctx.add({ path: repoPath, content: lines("import { db } from '../db';", '', ...OPERATIONS.map(({ sql }, position) => `export async function ${repoFns[position]}(id: string): Promise<unknown[]> { return db.query('${sql.replace('{table}', table)}', [id]); }`)) });
  const routes = OPERATIONS.map(({ verb, method, suffix }, position) => {
    const name = `${verb}${pascal(ctx.freshWord())}`;
    const path = `${handlerDir}/${name}.ts`;
    ctx.add({ path, content: handlerSource({ name, path, repoFn: repoFns[position] ?? '', repoPath }) });
    const route: RouteSpec = { group, method, path: `${routeBase}${suffix}`, handler: { name, file: path } };
    ctx.route(route);
    return { route, repoPath };
  });
  return { routes };
}

/**
 * Two resources served by one router (route → handler → repository with the SQL), the traced route among them, and
 * decoys: a commented-out route, an unmounted legacy router with the same path, a legacy handler of the same name, a
 * route registered only in a test, and docs listing a retired endpoint.
 */
export function plantApiRoutes(ctx: PlantContext): void {
  const group = ctx.freshWord();
  const resources = [plantResource({ ctx, group }), plantResource({ ctx, group })];
  const traced = ctx.prng.pick(resources.flatMap(({ routes }) => routes));
  const tracedLabel = `${traced.route.method} ${traced.route.path}`;
  ctx.term('route-trace.endpoint', tracedLabel);
  const answer = { kind: 'needle' as const, reason: 'on the traced route', answers: [TRACE], distinctive: [traced.route.handler.name] };
  ctx.note({ path: routerFileOf(group), ...answer, reason: 'registers the traced route' });
  ctx.note({ path: traced.route.handler.file, ...answer, reason: 'handles the traced route' });
  ctx.note({ path: traced.repoPath, ...answer, reason: 'runs the traced route\'s query' });
  const retired = `${traced.route.path}/legacy`;
  ctx.route({ group, method: 'DELETE', path: retired, handler: traced.route.handler, isCommented: true });
  const legacyDir = 'src/server/legacy';
  const legacyHandler = `${legacyDir}/${traced.route.handler.name}.ts`;
  ctx.add({ path: legacyHandler, content: lines(`// Old version of the handler; the live one is registered by the router.`, `export async function ${traced.route.handler.name}(): Promise<unknown> {`, "  return { status: 410, body: 'gone' };", '}'), item: { kind: 'decoy', reason: 'legacy handler with the same name, not registered', decoyFor: [TRACE] } });
  const legacyRouter = `${legacyDir}/legacy-router.ts`;
  ctx.add({
    path: legacyRouter,
    content: lines("import { createRouter } from '../http';", `import { ${traced.route.handler.name} } from './${traced.route.handler.name}';`, '', 'export const legacyRouter = createRouter();', '', `legacyRouter.${traced.route.method.toLowerCase()}('${traced.route.path}', ${traced.route.handler.name});`, `legacyRouter.get('${traced.route.path}/archive', ${traced.route.handler.name});`),
    item: { kind: 'decoy', reason: 'router that is never mounted', decoyFor: [TRACE, ENDPOINTS] },
  });
  ctx.add({ path: `src/server/api/routes.test.ts`, content: lines("import { createRouter } from '../http';", "import { expect, it } from 'vitest';", '', "it('registers', () => {", '  const router = createRouter();', "  router.post('/api/test-only', async () => ({ status: 200, body: null }));", '  expect(router.routes).toHaveLength(1);', '});'), item: { kind: 'decoy', reason: 'route registered only in a test', decoyFor: [ENDPOINTS] } });
  ctx.add({ path: 'docs/api.md', content: markdownDoc({ title: 'HTTP API', paragraphs: [`Retired: DELETE ${retired}.`, 'See the routers for the live list.'] }), item: { kind: 'decoy', reason: 'docs listing a retired endpoint', decoyFor: [ENDPOINTS] } });
  ctx.criteria('endpoints-forbidden', { required: [], forbidden: [`DELETE ${retired}`, `GET ${traced.route.path}/archive`, 'POST /api/test-only'] });
}
