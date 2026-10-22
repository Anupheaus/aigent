import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCard } from './file-cards.js';
import { linkCards } from './index-graph.js';
import type { IndexSnapshot } from './index-types.js';
import { traceRoute } from './repo-find.js';

const link = (files: Record<string, string>) => linkCards(Object.entries(files).map(([path, text]) => buildCard({ path, text, size: text.length, hash: createHash('sha256').update(text).digest('hex') })));
const snapshotOf = (files: Record<string, string>): IndexSnapshot => ({ root: '/ws', version: 'v', files: link(files).files, processed: [], skipped: {}, unreadable: [] });

/** Hand-labelled Express shapes: path mounts, aliases, default exports, barrels, middleware, nested routers, and an unmounted router that shares a mounted one's name. */
const EXPRESS = {
  'src/app.ts': [
    "import express from 'express';",
    "import { router as usersRouter } from './routes/users';",
    "import adminRouter from './routes/admin';",
    "import { api } from './routes';",
    'const app = express();',
    'app.use(express.json());',
    "app.use('/api', usersRouter);",
    "app.use('/admin', requireAdmin, adminRouter);",
    'app.use(api);',
    "app.get('/health', health);",
    'app.listen(3000);',
  ].join('\n'),
  'src/routes/users.ts': [
    "import { Router } from 'express';",
    "import { getUser, createUser } from '../handlers/users';",
    "import { auth } from '../auth';",
    'export const router = Router();',
    "router.get('/users/:id', getUser);",
    "router.post('/users', auth, createUser);",
    "router.delete('/users/:id', (req, res) => res.sendStatus(204));",
  ].join('\n'),
  'src/routes/admin.ts': "import express from 'express';\nconst adminRouter = express.Router();\nadminRouter.get('/stats', stats);\nfunction stats(req, res) { res.json({}); }\nexport default adminRouter;\n",
  'src/routes/index.ts': "export { api } from './api';\n",
  'src/routes/api.ts': "import { Router } from 'express';\nimport { orders } from './orders';\nexport const api = Router();\napi.get('/ping', ping);\napi.use('/orders', orders);\nfunction ping(req, res) { res.send('pong'); }\n",
  'src/routes/orders.ts': "import { Router } from 'express';\nexport const orders = Router();\norders.get('/:id', getOrder);\n",
  'src/routes/v2.ts': "import { Router } from 'express';\nimport { items } from './items';\nexport const v2 = Router();\nv2.use('/items', items);\n",
  'src/routes/items.ts': "import { Router } from 'express';\nexport const items = Router();\nitems.get('/:id', getItem);\n",
  'src/legacy/users.ts': "import { Router } from 'express';\nexport const router = Router();\nrouter.get('/legacy-unmounted', old);\n",
  'src/handlers/users.ts': "import { findUser } from '../data/users';\nexport async function getUser(req, res) { res.json(await findUser(req.params.id)); }\nexport async function createUser(req, res) { res.json({}); }\n",
  'src/data/users.ts': "export async function findUser(id) { return db.query('select 1', [id]); }\n",
};

describe('route liveness (hand-labelled Express fixtures)', () => {
  const { files } = link(EXPRESS);
  const live = [...files.values()].flatMap(({ liveRoutes }) => liveRoutes.map(({ method, path }) => `${method} ${path}`)).sort();

  it('serves exactly the routes reachable from the app, with their mount prefixes', () => {
    expect(live).toEqual(['DELETE /api/users/:id', 'GET /admin/stats', 'GET /api/users/:id', 'GET /health', 'GET /orders/:id', 'GET /ping', 'POST /api/users']);
  });

  it('resolves a mounted name through the mounting file\'s imports, so a same-named unmounted router stays dead', () => {
    expect(files.get('src/legacy/users.ts')?.liveRoutes).toEqual([]);
    expect(files.get('src/routes/items.ts')?.liveRoutes).toEqual([]);
  });

  it('traces a route behind a path mount and middleware to its handler and data module', () => {
    const snapshot = snapshotOf(EXPRESS);
    expect(traceRoute({ snapshot, route: 'GET /api/users/:id' })).toEqual([{ registeredIn: 'src/routes/users.ts', path: '/api/users/:id', handler: 'getUser', handlerFile: 'src/handlers/users.ts', callees: [{ path: 'src/data/users.ts', tags: ['data-access'] }] }]);
    expect(traceRoute({ snapshot, route: 'POST /api/users' })).toMatchObject([{ handler: 'createUser', handlerFile: 'src/handlers/users.ts' }]);
    expect(traceRoute({ snapshot, route: 'GET /legacy-unmounted' })).toEqual([]);
  });
});

/** Dead exports that a name-counting rule gets wrong: a same-named local elsewhere, namespace and star re-exports, aliases. */
const EXPORTS = {
  'src/a.ts': 'export function formatName(x: string) { return x; }\nexport function shared() { return 1; }\n',
  'src/b.ts': 'function formatName(y: number) { return String(y); }\nexport function main() { return formatName(1); }\n',
  'src/c.ts': "import { main } from './b';\nimport { shared as aliased } from './a';\nmain();\naliased();\n",
  'src/d.ts': 'export function viaNamespace() { return 1; }\nexport function notViaNamespace() { return 2; }\n',
  'src/e.ts': "import * as d from './d';\nd.viaNamespace();\n",
  'src/f.ts': 'export function starred() { return 1; }\n',
  'src/barrel.ts': "export * from './f';\n",
  'src/g.ts': 'export function onlyInternal() { return 1; }\nonlyInternal();\n',
  'src/h.ts': 'export function viaAlias() { return 1; }\n',
  'src/i.ts': "import { viaAlias } from '@app/h';\nviaAlias();\n",
};

describe('unused exports (resolved through imports)', () => {
  const { files } = link(EXPORTS);
  const unused = Object.fromEntries([...files.entries()].map(([path, { unusedExports }]) => [path, unusedExports]));

  it('a same-named local function in another file does not keep an export alive', () => {
    expect(unused['src/a.ts']).toEqual(['formatName']);
    expect(unused['src/b.ts']).toEqual([]);
  });

  it('counts named, aliased, namespace and star re-export uses, never uses inside the declaring file', () => {
    expect(unused['src/d.ts']).toEqual(['notViaNamespace']);
    expect(unused['src/f.ts']).toEqual([]);
    expect(unused['src/g.ts']).toEqual(['onlyInternal']);
  });

  it('keeps a name imported from a specifier it cannot resolve (a path alias) alive, rather than report it dead', () => {
    expect(unused['src/h.ts']).toEqual([]);
  });
});
