import { describe, expect, it } from 'vitest';
import { createAigent } from '../../../core/create-aigent.js';
import type { FsAccess } from '../../../security/fs-access.js';
import { createMemoryFsAccess } from '../../../security/fs-access-memory.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import type { Tool } from '../../tool-types.js';
import { fsTools } from '../fs/fs-tools.js';
import { call, entriesOf } from '../fs/fs-tools.test-support.js';
import { indexTools } from './index-tools.js';

const FILES = {
  '/ws/src/server/app.ts': "import { api } from './routes';\nserver.use(api);\n",
  '/ws/src/server/routes.ts': "import { getUser } from './users';\nexport const api = createRouter();\napi.get('/users/:id', getUser);\n",
  '/ws/src/server/users.ts': "import { loadUser } from './user-repo';\nexport async function getUser(request: ApiRequest) {\n  return loadUser(request.params.id);\n}\n",
  '/ws/src/server/user-repo.ts': "export async function loadUser(id: string) {\n  return db.query('select 1', [id]);\n}\n",
  '/ws/src/ui/Card.tsx': '// Shows a person.\nexport function Card({ person }: Props) {\n  return <p>{person.email}</p>;\n}\n',
  '/ws/src/ui/Card.test.tsx': "import { Card } from './Card';\nit('total', () => Card);\n",
  '/ws/src/lib/total.ts': '// total is mentioned here\nexport function total(values: number[]): number {\n  return values.length;\n}\nexport const unused = (value: number) => value;\n',
  '/ws/src/lib/use.ts': "import { total } from './total';\nexport const all = total([1]);\nconst note = 'total';\n",
};

const tools = () => {
  const access = createMemoryFsAccess({ platform: 'posix', files: FILES });
  return { access, tools: indexTools({ policy: createFsPolicy({ roots: [{ path: '/ws', permissions: ['read', 'write'] }] }), access }) };
};
const run = async (name: string, items: unknown[]) => {
  const tool = tools().tools.find(candidate => candidate.name === name);
  if (tool == null) throw new TypeError(`no tool ${name}`);
  return entriesOf(await call({ tool, items })).map(({ result }) => result);
};

describe('index tools', () => {
  it('repo_map counts files per directory and language, and tags', async () => {
    const [map] = await run('repo_map', [{ depth: 2 }]);
    expect(map).toMatchObject({ totalFiles: 8, languages: { ts: 6, tsx: 2 }, directories: expect.arrayContaining([{ path: 'src/server', files: 4, languages: { ts: 4 } }]), tags: { 'react-component': 1, test: 1 } });
  });

  it('repo_find finds by name, symbol, importers and unused exports, and traces a route', async () => {
    const [byName, bySymbol, importers, unused, route] = await run('repo_find', [{ name: 'Card.tsx' }, { symbol: 'total' }, { importersOf: 'src/lib/total.ts' }, { unusedExports: true }, { route: 'GET /users/:id' }]);
    expect(byName).toMatchObject({ cards: [{ path: 'src/ui/Card.tsx', reasons: ['exact name'] }, { path: 'src/ui/Card.test.tsx', reasons: ['fuzzy name'] }] });
    expect(bySymbol).toMatchObject({ total: 2, cards: [{ path: 'src/lib/total.ts', reasons: ['defines symbol'] }, { path: 'src/lib/use.ts', reasons: ['uses symbol'] }] });
    expect(importers).toMatchObject({ cards: [{ path: 'src/lib/use.ts' }] });
    expect(unused).toMatchObject({ total: 1, cards: [{ path: 'src/lib/total.ts', unusedExports: ['unused'] }] });
    expect(route).toEqual({ route: 'GET /users/:id', registrations: [{ registeredIn: 'src/server/routes.ts', path: '/users/:id', handler: 'getUser', handlerFile: 'src/server/users.ts', callees: [{ path: 'src/server/user-repo.ts', tags: ['data-access'] }] }] });
  });

  it('repo_tags lists files by tag, counts first, with live routes', async () => {
    const [tagged] = await run('repo_tags', [{ tags: ['api-route', 'renders-customer-data'] }]);
    expect(tagged).toEqual({ counts: { 'api-route': 1, 'renders-customer-data': 1 }, total: 2, files: [{ path: 'src/server/routes.ts', tags: ['api-route'], importers: 1, routes: ['GET /users/:id'] }, { path: 'src/ui/Card.tsx', tags: ['react-component', 'renders-customer-data'], importers: 1 }] });
  });

  it('search_layers answers the same query at each layer, in code only when asked, with paging', async () => {
    const [counts, files, code, snippets, paged] = await run('search_layers', [
      { pattern: 'total', layer: 'counts' }, { pattern: 'total', layer: 'files', excludeTags: ['test'] }, { pattern: 'total', layer: 'files', where: 'code', wholeWord: true },
      { pattern: 'loadUser', layer: 'snippets' }, { pattern: 'total', layer: 'files', limit: 1 },
    ]);
    expect(counts).toEqual({ totalMatches: 6, filesWithMatches: 3, byDirectory: { 'src/lib': 5, 'src/ui': 1 } });
    expect(files).toMatchObject({ files: [{ path: 'src/lib/total.ts', defines: true }, { path: 'src/lib/use.ts' }] });
    expect(code).toMatchObject({ totalMatches: 3, files: [{ path: 'src/lib/total.ts', count: 1 }, { path: 'src/lib/use.ts', count: 2 }] });
    expect(snippets).toMatchObject({ files: [{ path: 'src/server/user-repo.ts', lines: [{ line: 1, text: 'export async function loadUser(id: string) {' }] }, { path: 'src/server/users.ts' }] });
    expect(paged).toMatchObject({ files: [{ path: 'src/lib/total.ts' }], more: { files: 2, next: { offset: 1 } } });
  });

  it('serves repeats from the cache keyed by the index version, and never after a file changed', async () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: FILES });
    const policy = createFsPolicy({ roots: [{ path: '/ws', permissions: ['read', 'write'] }] });
    const ask = (id: string) => toolTurn([{ id, name: 'repo_find', args: { items: [{ name: 'total.ts' }] } }]);
    const edit = toolTurn([{ id: 'w1', name: 'fs_write', args: { items: [{ path: 'src/lib/use.ts', content: 'export const x = 1;\n', overwrite: true }] } }]);
    const provider = createFakeProvider({ turns: [ask('f1'), ask('f2'), edit, ask('f3'), textTurn('done')] });
    const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
    const agent = ai.agent({ name: 'indexer', model: 'fake:m', todo: false, tools: [...indexTools({ policy, access }), ...fsTools({ policy, access, approvals: 'none' }).filter(({ name }) => name === 'fs_write')] });
    const result = await agent.task({ task: 'find' });
    const trace = await ai.trace(result.runId);
    expect(trace?.steps.filter(({ tool }) => tool === 'repo_find').map(({ cacheHit }) => cacheHit)).toEqual([false, true, false]);
    await ai.close();
  });
  it('refuses unknown tags with the list of known ones', async () => {
    const tool = tools().tools.find(({ name }) => name === 'repo_tags');
    if (tool == null) throw new TypeError('no repo_tags');
    const [refused] = entriesOf(await call({ tool, items: [{ tags: ['widgets'] }] }));
    expect(refused).toMatchObject({ ok: false, error: { code: 'unknown_tag' } });
  });

  it('refuses unsafe patterns per item', async () => {
    const tool = tools().tools.find(({ name }) => name === 'search_layers');
    if (tool == null) throw new TypeError('no search_layers');
    const [entry] = entriesOf(await call({ tool, items: [{ pattern: '(a+)+$', regex: true, layer: 'files' }] }));
    expect(entry).toMatchObject({ ok: false, error: { code: 'unsafe_pattern' } });
  });

  it('takes its regex budget from searchBudgetMs', async () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: { ...FILES, '/ws/src/slow.ts': `// ${'a'.repeat(3_000)}\n` } });
    const tool = indexTools({ policy: createFsPolicy({ roots: [{ path: '/ws', permissions: ['read'] }] }), access, searchBudgetMs: 200 }).find(({ name }) => name === 'search_layers');
    if (tool == null) throw new TypeError('no search_layers');
    const started = performance.now();
    const [entry] = entriesOf(await call({ tool, items: [{ pattern: '.*a.*a.*a.*a.*!', regex: true, layer: 'files' }] }));
    expect(entry).toMatchObject({ ok: false, error: { code: 'search_stopped' } });
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 30_000);
});

/** An access whose reads of `failing` fail: always, only the first `failures` times, or after the first `succeed` reads. */
const faulty = (params: { failing: string; failures?: number; succeed?: number }) => {
  const { failing, failures = Number.MAX_SAFE_INTEGER, succeed = 0 } = params;
  const base = createMemoryFsAccess({ platform: 'posix', files: FILES });
  let reads = 0;
  let walks = 0;
  const guard = (path: string): void => {
    if (path !== failing) return;
    reads += 1;
    if (reads > succeed && reads <= succeed + failures) throw Object.assign(new Error(`EIO: injected '${path}'`), { code: 'EIO' });
  };
  const access: FsAccess = {
    ...base,
    readFile: async path => { guard(path); return base.readFile(path); },
    open: async path => { guard(path); return base.open(path); },
    readdir: async path => { if (path === '/ws') walks += 1; return base.readdir(path); },
  };
  return { access, walks: () => walks };
};
const toolNamed = (access: FsAccess, name: string): Tool => {
  const tool = indexTools({ policy: createFsPolicy({ roots: [{ path: '/ws', permissions: ['read'] }] }), access }).find(candidate => candidate.name === name);
  if (tool == null) throw new TypeError(`no tool ${name}`);
  return tool;
};
const firstResult = async (params: { access: FsAccess; name: string; item: unknown }) => entriesOf(await call({ tool: toolNamed(params.access, params.name), items: [params.item] }))[0]?.result;

describe('index tools: unreadable files are reported, never silently dropped', () => {
  const USE = '/ws/src/lib/use.ts';

  it('every tool reports a file that cannot be read (after a retry) in skipped and unreadable', async () => {
    const { access } = faulty({ failing: USE });
    for (const [name, item] of [['search_layers', { pattern: 'total', layer: 'files' }], ['repo_find', { name: 'use.ts' }], ['repo_map', {}], ['repo_tags', { tags: ['test'] }]] as const) {
      expect(await firstResult({ access, name, item }), name).toMatchObject({ skipped: { unreadable: 1 }, unreadable: ['src/lib/use.ts'] });
    }
  });

  it('retries a failed read once, deliberately: a transient failure costs nothing and is not reported', async () => {
    const result = await firstResult({ access: faulty({ failing: USE, failures: 1 }).access, name: 'search_layers', item: { pattern: 'total', layer: 'files' } });
    expect(result).toMatchObject({ filesWithMatches: 3 });
    expect(result).not.toHaveProperty('unreadable');
  });

  it('a file that fails when searched (after indexing) is reported for that query, not a failed item', async () => {
    const result = await firstResult({ access: faulty({ failing: USE, succeed: 1 }).access, name: 'search_layers', item: { pattern: 'total', layer: 'files' } });
    expect(result).toMatchObject({ filesWithMatches: 2, unreadable: ['src/lib/use.ts'] });
  });

  it('walks the tree once per cached call (the validity token and the answer share one snapshot)', async () => {
    const { access, walks } = faulty({ failing: '/nowhere' });
    const ask = (id: string, name: string) => toolTurn([{ id, name: 'repo_find', args: { items: [{ name }] } }]);
    const provider = createFakeProvider({ turns: [ask('f1', 'total.ts'), ask('f2', 'use.ts'), textTurn('done')] });
    const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
    const agent = ai.agent({ name: 'indexer', model: 'fake:m', todo: false, tools: indexTools({ policy: createFsPolicy({ roots: [{ path: '/ws', permissions: ['read'] }] }), access }) });
    await agent.task({ task: 'find' });
    await ai.close();
    expect(walks()).toBe(2);
  });
});
