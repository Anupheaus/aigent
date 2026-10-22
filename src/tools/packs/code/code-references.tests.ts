import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, entriesOf } from '../fs/fs-tools.test-support.js';
import { createCodeReferences } from './code-references.js';
import { resolveCodeDeps, sourceFor } from './code-shared.js';
import type { CodeDeps } from './code-shared.js';
import { codeFixture } from './code-tools.test-support.js';
import type { CodeFixture } from './code-tools.test-support.js';
import { isKind } from './declarations.js';
import type { TsNode } from './ts-api.js';

let fixture: CodeFixture;
let deps: CodeDeps;

beforeAll(async () => { fixture = await codeFixture(); deps = resolveCodeDeps({ options: fixture.options }); });
afterAll(async () => { await fixture.cleanup(); });

interface Usage { line: number; character: number; text: string; kind: string }
interface References { symbol: string; total: number; skipped: number; truncated: boolean; files: { path: string; usages: Usage[] }[] }

async function references(item: Record<string, unknown>, own: CodeDeps = deps): Promise<References> {
  const [entry] = entriesOf(await call({ tool: createCodeReferences(own), items: [item] }));
  if (entry?.ok !== true) throw new Error(JSON.stringify(entry?.error));
  return entry.result as unknown as References;
}

/** Positions of every identifier that the compiler resolves (through aliases) to the same symbol: an independent walk. */
async function expectedPositions(params: { path: string; position: number }): Promise<string[]> {
  const { program } = await sourceFor({ deps, path: params.path });
  const { checker } = program.project;
  const resolve = async (file: string, position: number): Promise<number | undefined> => {
    const symbol = await checker.getSymbolAtPosition(file, position);
    if (symbol == null) return undefined;
    const target = (symbol.flags & 2_097_152) !== 0 ? await checker.getAliasedSymbol(symbol) : symbol;
    return await checker.isUnknownSymbol(target) ? undefined : target.id;
  };
  const target = await resolve(program.compilerPath(params.path) ?? '', params.position);
  const found: string[] = [];
  for (const { path } of program.files.entries) {
    const compilerPath = program.compilerPath(path) ?? '';
    const source = await program.project.program.getSourceFile(compilerPath);
    const identifiers: TsNode[] = [];
    const visit = (node: TsNode): undefined => {
      if (isKind({ node, kinds: program.syntaxKind, name: 'Identifier' })) identifiers.push(node);
      node.forEachChild(visit);
      return undefined;
    };
    if (source != null) visit(source);
    for (const node of identifiers) if (await resolve(compilerPath, node.getStart()) === target) found.push(`${path}:${node.getStart()}`);
  }
  return found.sort();
}

function positionsOf(result: References, texts: Record<string, string>): string[] {
  return result.files.flatMap(({ path, usages }) => usages.map(({ line, character }) => {
    const lines = (texts[path] ?? '').split('\n');
    return `${path}:${lines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0) + character - 1}`;
  })).sort();
}

describe('code_references', () => {
  it('finds every usage of a function, across a re-export and renamed imports, as the compiler resolves them', async () => {
    const { readFile } = await import('node:fs/promises');
    const texts: Record<string, string> = {};
    for (const relative of ['src/shapes.ts', 'src/index.ts', 'src/app.ts']) texts[fixture.at(relative)] = await readFile(fixture.at(relative), 'utf8');
    const result = await references({ path: fixture.at('src/shapes.ts'), line: 13, character: 17 });
    expect(result.symbol).toBe('scale');
    expect(positionsOf(result, texts)).toEqual(await expectedPositions({ path: fixture.at('src/shapes.ts'), position: (texts[fixture.at('src/shapes.ts')] ?? '').indexOf('scale(shape: Shape, factor = 1)') }));
    const kinds = result.files.flatMap(({ path, usages }) => usages.map(({ line, kind }) => `${path.slice(fixture.root.length + 1).replace(/\\/g, '/')}:${line}:${kind}`));
    expect(kinds).toEqual(expect.arrayContaining(['src/shapes.ts:13:definition', 'src/index.ts:1:import', 'src/app.ts:1:import', 'src/app.ts:5:call']));
    const shapes = result.files.find(({ path }) => path === fixture.at('src/shapes.ts'));
    expect(shapes?.usages[0]).toMatchObject({ line: 11, character: 17, text: 'export function scale(shape: Shape): number;', kind: 'definition' });
  });

  it('takes a symbol name instead of a position, and classifies type references', async () => {
    const result = await references({ path: fixture.at('src/shapes.ts'), symbol: 'Shape' });
    const kinds = new Set(result.files.flatMap(({ usages }) => usages.map(({ kind }) => kind)));
    expect([...kinds]).toEqual(expect.arrayContaining(['definition', 'type-ref']));
    expect(result.total).toBeGreaterThanOrEqual(6);
  });

  it('never reads or reports a file the policy denies, and fails clearly without a symbol at the position', async () => {
    const own = await codeFixture({ files: { 'lib.ts': 'export function shared(): number { return 1; }\n', 'use.ts': "import { shared } from './lib';\nshared();\n", 'secret.ts': "import { shared } from './lib';\nexport const key = shared();\n" }, policy: { denyGlobs: ['secret.ts'] } });
    const ownDeps = resolveCodeDeps({ options: own.options });
    const result = await references({ path: own.at('lib.ts'), symbol: 'shared' }, ownDeps);
    expect(result.files.map(({ path }) => path)).toEqual([own.at('lib.ts'), own.at('use.ts')]);
    expect(own.reads.some(path => path.endsWith('secret.ts'))).toBe(false);
    const [entry] = entriesOf(await call({ tool: createCodeReferences(ownDeps), items: [{ path: own.at('lib.ts'), line: 1, character: 1 }, { path: own.at('lib.ts') }] }));
    expect(entry).toMatchObject({ ok: false, error: { code: 'no_symbol_at_position' } });
    await own.cleanup();
  });
});
