import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, entriesOf } from '../fs/fs-tools.test-support.js';
import { createCodeFindSymbol } from './code-find-symbol.js';
import { resolveCodeDeps } from './code-shared.js';
import type { CodeDeps } from './code-shared.js';
import { codeFixture } from './code-tools.test-support.js';
import type { CodeFixture } from './code-tools.test-support.js';

let fixture: CodeFixture;
let deps: CodeDeps;

beforeAll(async () => { fixture = await codeFixture(); deps = resolveCodeDeps({ options: fixture.options }); });
afterAll(async () => { await fixture.cleanup(); });

interface Definition { path: string; line: number; kind: string; signature: string; containerName?: string; exported: boolean; reexportedFrom?: { path: string; line: number; as: string }[] }
interface Found { name: string; total: number; truncated: boolean; definitions: Definition[] }

async function find(item: Record<string, unknown>): Promise<Found> {
  const [entry] = entriesOf(await call({ tool: createCodeFindSymbol(deps), items: [item] }));
  if (entry?.ok !== true) throw new Error(JSON.stringify(entry?.error));
  return entry.result as unknown as Found;
}

describe('code_find_symbol', () => {
  it('finds a function by name with its overloads, and says where it is re-exported and imported under other names', async () => {
    const found = await find({ name: 'scale' });
    expect(found.definitions.map(({ path, line, kind }) => [path, line, kind])).toEqual([[fixture.at('src/shapes.ts'), 11, 'function'], [fixture.at('src/shapes.ts'), 12, 'function'], [fixture.at('src/shapes.ts'), 13, 'function']]);
    expect(found.definitions[2]?.reexportedFrom).toEqual([{ path: fixture.at('src/index.ts'), line: 1, as: 'resize' }]);
    expect(found.definitions[2]?.signature).toBe('export function scale(shape: Shape, factor = 1): number');
    // The copy in node_modules is not part of the project.
    expect(found.total).toBe(3);
  });

  it('resolves an alias through a re-export chain or an aliased import to the real definition', async () => {
    const resize = await find({ name: 'resize' });
    expect(resize.definitions.map(({ path, line, kind }) => [path, line, kind])).toEqual([[fixture.at('src/shapes.ts'), 13, 'function']]);
    expect(resize.definitions[0]?.reexportedFrom).toEqual(expect.arrayContaining([{ path: fixture.at('src/index.ts'), line: 1, as: 'resize' }]));
    const round = await find({ name: 'Round' });
    expect(round.definitions.map(({ path, line, kind }) => [path, line, kind])).toEqual([[fixture.at('src/shapes.ts'), 5, 'class']]);
    expect(round.definitions[0]?.reexportedFrom).toEqual(expect.arrayContaining([{ path: fixture.at('src/app.ts'), line: 1, as: 'Round' }]));
  });

  it('lists merged declarations and members with their container, filtered by kind, scope and export', async () => {
    const shape = await find({ name: 'Shape' });
    expect(shape.definitions.map(({ kind, line }) => [kind, line])).toEqual([['interface', 2], ['interface', 3], ['namespace', 4]]);
    const area = await find({ name: 'area' });
    expect(area.definitions.map(({ kind, containerName }) => [kind, containerName])).toEqual([['method', 'Shape'], ['method', 'Circle']]);
    expect((await find({ name: 'area', kind: 'method', scope: 'src/util' })).total).toBe(0);
    expect((await find({ name: 'Shape', kind: 'namespace' })).definitions).toHaveLength(1);
    expect((await find({ name: 'hidden', exportedOnly: true })).total).toBe(0);
    expect((await find({ name: 'hidden' })).definitions[0]).toMatchObject({ kind: 'const', exported: false, line: 16 });
  });

  it('finds a default-exported function by its own name', async () => {
    expect((await find({ name: 'describe' })).definitions.map(({ path, line, kind, exported }) => [path, line, kind, exported])).toEqual([[fixture.at('src/shapes.ts'), 17, 'function', true]]);
  });

  it('never invents a result for a name that is not declared', async () => {
    expect(await find({ name: 'doesNotExist' })).toEqual({ name: 'doesNotExist', total: 0, truncated: false, definitions: [] });
    expect((await find({ name: 'Math' })).total).toBe(0);
  });

  it('ranks exact names first, exported before not, shallow paths first, and truncates with the total', async () => {
    const files: Record<string, string> = { 'deep/a/b/item.ts': 'export const item = 1;\n', 'item.ts': 'const item = 2;\nexport function Item(): void {}\n', 'mid/item.ts': 'export const item = 3;\n' };
    const own = await codeFixture({ files });
    const ownDeps = resolveCodeDeps({ options: own.options });
    const [entry] = entriesOf(await call({ tool: createCodeFindSymbol(ownDeps), items: [{ name: 'item', maxResults: 3 }] }));
    const found = entry?.result as unknown as Found;
    expect(found.definitions.map(({ path, exported }) => [path.slice(own.root.length + 1).replace(/\\/g, '/'), exported])).toEqual([['mid/item.ts', true], ['deep/a/b/item.ts', true], ['item.ts', false]]);
    expect(found).toMatchObject({ total: 4, truncated: true });
    await own.cleanup();
  });
});
