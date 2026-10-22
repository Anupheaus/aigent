import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, entriesOf } from '../fs/fs-tools.test-support.js';
import { createCodeOutline } from './code-outline.js';
import { resolveCodeDeps } from './code-shared.js';
import type { CodeDeps } from './code-shared.js';
import { codeFixture } from './code-tools.test-support.js';
import type { CodeFixture } from './code-tools.test-support.js';

let fixture: CodeFixture;
let deps: CodeDeps;

beforeAll(async () => { fixture = await codeFixture(); deps = resolveCodeDeps({ options: fixture.options }); });
afterAll(async () => { await fixture.cleanup(); });

type Outline = { name: string; kind: string; line: number; exported: boolean; signature: string; children: Outline[] };

describe('code_outline', () => {
  it('outlines a file: merged declarations, members, overloads, enums, types and the default export, without bodies', async () => {
    const [entry] = entriesOf(await call({ tool: createCodeOutline(deps), items: [{ path: fixture.at('src/shapes.ts') }] }));
    const symbols = (entry?.result as { symbols: Outline[] }).symbols;
    expect(symbols.map(({ name, kind, line, exported }) => [name, kind, line, exported])).toEqual([
      ['Shape', 'interface', 2, true], ['Shape', 'interface', 3, true], ['Shape', 'namespace', 4, true], ['Circle', 'class', 5, true],
      ['scale', 'function', 11, true], ['scale', 'function', 12, true], ['scale', 'function', 13, true], ['Color', 'enum', 14, true],
      ['Pair', 'type', 15, true], ['hidden', 'const', 16, false], ['describe', 'function', 17, true],
    ]);
    const circle = symbols.find(({ name }) => name === 'Circle');
    expect(circle?.children.map(({ name, kind }) => [name, kind])).toEqual([['name', 'property'], ['constructor', 'constructor'], ['area', 'method'], ['diameter', 'getter']]);
    expect(symbols[2]?.children.map(({ name, kind }) => [name, kind])).toEqual([['unit', 'const']]);
    expect(symbols[6]?.signature).toBe('export function scale(shape: Shape, factor = 1): number');
    expect(circle?.signature).toBe('export class Circle implements Shape');
    expect(symbols[7]?.children.map(({ name }) => name)).toEqual(['Red', 'Green']);
    expect(JSON.stringify(symbols)).not.toContain('Math.PI');
  });

  it('lists re-exports and reads JavaScript and TSX', async () => {
    const entries = entriesOf(await call({ tool: createCodeOutline(deps), items: [{ path: fixture.at('src/index.ts') }, { path: fixture.at('src/legacy.js') }, { path: fixture.at('src/view.tsx') }] }));
    expect((entries[0]?.result as { symbols: Outline[] }).symbols.map(({ name, kind }) => [name, kind])).toEqual([['resize, Circle', 're-export'], ['*', 're-export']]);
    expect((entries[1]?.result as { symbols: Outline[] }).symbols.map(({ name, kind }) => [name, kind])).toEqual([['old', 'function']]);
    expect((entries[2]?.result as { symbols: Outline[] }).symbols.map(({ name, kind }) => [name, kind])).toEqual([['View', 'const']]);
  });

  it('refuses other languages, paths outside the roots and files not in the index, per item', async () => {
    const entries = entriesOf(await call({ tool: createCodeOutline(deps), items: [{ path: fixture.at('README.md') }, { path: '/etc/hosts.ts' }, { path: fixture.at('node_modules/dep/index.ts') }] }));
    expect(entries[0]).toMatchObject({ ok: false, error: { code: 'unsupported_language', suggestion: expect.stringContaining('fs_search') } });
    expect(entries[1]).toMatchObject({ ok: false, error: { category: 'denied' } });
    expect(entries[2]).toMatchObject({ ok: false, error: { code: 'not_in_project' } });
  });

  it('sees a file change: the program is rebuilt when a file\'s mtime or size changes', async () => {
    const own = await codeFixture({ files: { 'a.ts': 'export const first = 1;\n' } });
    const ownDeps = resolveCodeDeps({ options: own.options });
    const outline = async () => (entriesOf(await call({ tool: createCodeOutline(ownDeps), items: [{ path: own.at('a.ts') }] }))[0]?.result as { symbols: Outline[] }).symbols.map(({ name }) => name);
    expect(await outline()).toEqual(['first']);
    await writeFile(own.at('a.ts'), 'export const first = 1;\nexport const second = 2;\n');
    expect(await outline()).toEqual(['first', 'second']);
    await own.cleanup();
  });

  it('marks names exported through an export list or `export default <name>` as exported', async () => {
    const own = await codeFixture({ files: { 'list.ts': 'function foo() {}\nconst bar = 2;\nlet kept = 3;\nexport { foo, bar as baz };\nexport default bar;\n', 'assign.ts': 'function only() {}\nexport = only;\n' } });
    const ownDeps = resolveCodeDeps({ options: own.options });
    const entries = entriesOf(await call({ tool: createCodeOutline(ownDeps), items: [{ path: own.at('list.ts') }, { path: own.at('assign.ts') }] }));
    expect((entries[0]?.result as { symbols: Outline[] }).symbols.map(({ name, kind, exported }) => [name, kind, exported])).toEqual([
      ['foo', 'function', true], ['bar', 'const', true], ['kept', 'variable', false], ['foo, baz', 're-export', true], ['default', 'export-default', true],
    ]);
    expect((entries[1]?.result as { symbols: Outline[] }).symbols.map(({ name, exported }) => [name, exported])).toEqual([['only', true], ['default', true]]);
    await own.cleanup();
  });

  it('says clearly when the TypeScript peer is missing', async () => {
    const missing = resolveCodeDeps({ options: fixture.options, loadTypeScript: async () => { throw new Error("Cannot find package 'typescript'"); } });
    const [entry] = entriesOf(await call({ tool: createCodeOutline(missing), items: [{ path: fixture.at('src/util.ts') }] }));
    expect(entry).toMatchObject({ ok: false, error: { code: 'typescript_unavailable', message: expect.stringContaining('typescript'), suggestion: expect.stringContaining('npm install') } });
  });
});
