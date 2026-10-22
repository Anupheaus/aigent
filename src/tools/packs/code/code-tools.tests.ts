import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAigent } from '../../../core/create-aigent.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import { call, entriesOf } from '../fs/fs-tools.test-support.js';
import { createCodeFindSymbol } from './code-find-symbol.js';
import { createCodeOutline } from './code-outline.js';
import type { TsModules } from './ts-api.js';
import { loadTypeScript } from './ts-loader.js';
import { resolveCodeDeps } from './code-shared.js';
import { codeFixture } from './code-tools.test-support.js';
import type { CodeFixture } from './code-tools.test-support.js';
import { codeTools } from './index.js';

const GENERATED_FILES = 2_000;
const MAX_FILES = 500;

describe('codeTools', () => {
  let fixture: CodeFixture;
  beforeAll(async () => { fixture = await codeFixture(); });
  afterAll(async () => { await fixture.cleanup(); });

  it('registers the three tools, cached and verbatim, and needs a policy', () => {
    expect(codeTools(fixture.options).map(({ name, cache, deterministic, contentKind, fidelity, hasSideEffects }) => [name, cache, deterministic, contentKind, fidelity, hasSideEffects])).toEqual([
      ['code_outline', true, false, 'search-hits', 'verbatim', false], ['code_find_symbol', true, false, 'search-hits', 'verbatim', false], ['code_references', true, false, 'search-hits', 'verbatim', false],
    ]);
    expect(() => codeTools({} as never)).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });

  it('answers "where is X defined?" through the agent loop in one tool call', async () => {
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'c1', name: 'code_find_symbol', args: { items: [{ name: 'resize' }] } }]), textTurn('resize is scale in src/shapes.ts, line 13.')] });
    const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
    const agent = ai.agent({ name: 'coder', model: 'fake:m', todo: false, tools: codeTools(fixture.options) });
    const result = await agent.task({ task: 'Where is resize defined?' });
    expect(result.usage.toolCalls).toBe(1);
    const seen = JSON.parse(provider.requests[1]?.messages.find(({ toolCallId }) => toolCallId === 'c1')?.text ?? '{}') as { result: { result: { definitions: { path: string; line: number }[] } }[] };
    expect(seen.result[0]?.result.definitions[0]).toMatchObject({ path: fixture.at('src/shapes.ts'), line: 13 });
  });
});

describe('the typescript peer dependency', () => {
  // npm checks an optional peer's range whenever the package is installed, so a narrow range would refuse every
  // consumer on TypeScript 5 or 6 even when they never use the code pack; the loader checks the API instead.
  it('accepts any installed version and stays optional', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional?: boolean }> };
    expect(packageJson.peerDependencies.typescript).toBe('*');
    expect(packageJson.peerDependenciesMeta.typescript?.optional).toBe(true);
  });
});

/** The real TypeScript, counting the compiler processes opened and closed. */
function countingTypeScript(): { load(): Promise<TsModules>; opened(): number; closed(): number } {
  let opened = 0;
  let closed = 0;
  return {
    opened: () => opened,
    closed: () => closed,
    load: async () => {
      const real = await loadTypeScript();
      return {
        ...real,
        createApi: params => {
          const api = real.createApi(params);
          opened += 1;
          return { updateSnapshot: snapshot => api.updateSnapshot(snapshot), detach: () => api.detach(), close: async () => { closed += 1; await api.close(); } };
        },
      };
    },
  };
}

const IDLE_CLOSE_MS = 50;
const IDLE_WAIT_MS = 300;

describe('compiler processes (review I6)', () => {
  let fixture: CodeFixture;
  beforeAll(async () => { fixture = await codeFixture(); });
  afterAll(async () => { await fixture.cleanup(); });

  it('dispose closes every compiler process, and a later call builds again', async () => {
    const typescript = countingTypeScript();
    const deps = resolveCodeDeps({ options: fixture.options, loadTypeScript: typescript.load });
    const outline = async () => entriesOf(await call({ tool: createCodeOutline(deps), items: [{ path: fixture.at('src/util.ts') }] }))[0];
    expect(await outline()).toMatchObject({ ok: true });
    expect([typescript.opened(), typescript.closed()]).toEqual([1, 0]);
    await deps.programs.dispose();
    expect(typescript.closed()).toBe(1);
    expect(await outline()).toMatchObject({ ok: true });
    expect([typescript.opened(), typescript.closed()]).toEqual([2, 1]);
    await deps.programs.dispose();
  });

  it('closes a program left idle for idleCloseMs', async () => {
    const typescript = countingTypeScript();
    const deps = resolveCodeDeps({ options: { ...fixture.options, idleCloseMs: IDLE_CLOSE_MS }, loadTypeScript: typescript.load });
    expect(entriesOf(await call({ tool: createCodeOutline(deps), items: [{ path: fixture.at('src/util.ts') }] }))[0]).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, IDLE_WAIT_MS));
    expect([typescript.opened(), typescript.closed()]).toEqual([1, 1]);
  });

  it('gives every tool of one codeTools() the same dispose, so ai.close() closes the pack once', () => {
    const tools = codeTools(fixture.options);
    expect(new Set(tools.map(({ dispose }) => dispose)).size).toBe(1);
    expect(typeof tools[0]?.dispose).toBe('function');
  });
});

/** Longest pause of the event loop tolerated while a program builds (the build runs in the compiler's own process). */
const MAX_LOOP_GAP_MS = 500;
const STALL_FILES = 3_000;
const LOOP_SAMPLE_MS = 10;

describe('building a large program', () => {
  it('keeps the event loop responsive: timers and other work run while the compiler builds (review I5)', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < STALL_FILES; index += 1) {
      const next = (index + 1) % STALL_FILES;
      files[`pkg${index % 30}/file${index}.ts`] = `import { fn${next} } from '../pkg${next % 30}/file${next}';\nexport interface I${index} { a: string; b: number; c(): void }\nexport class C${index} implements I${index} { a = ''; b = 0; c() { fn${next}(); } }\nexport function fn${index}(x: number = ${index}): number { return x + ${index}; }\nexport const use${index} = () => fn${next}();\n`;
    }
    const big = await codeFixture({ files, policy: { maxFiles: 10_000 } });
    const tools = codeTools(big.options);
    const findSymbol = tools.find(({ name }) => name === 'code_find_symbol');
    if (findSymbol == null) throw new Error('code_find_symbol is missing');
    let last = performance.now();
    let longestGap = 0;
    const sample = (): void => { const now = performance.now(); longestGap = Math.max(longestGap, now - last); last = now; };
    const sampler = setInterval(sample, LOOP_SAMPLE_MS);
    try {
      const [entry] = entriesOf(await call({ tool: findSymbol, items: [{ name: 'fn1' }] }));
      // The gap still open when the call ends counts too.
      sample();
      expect(entry).toMatchObject({ ok: true });
    } finally {
      clearInterval(sampler);
      await Promise.all(tools.map(tool => tool.dispose?.()));
      await big.cleanup();
    }
    expect(longestGap).toBeLessThan(MAX_LOOP_GAP_MS);
  }, 120_000);
});

describe('a large project', () => {
  it('builds within a generous time budget and honours maxFiles with a marker', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < GENERATED_FILES; index += 1) files[`pkg${index % 20}/file${index}.ts`] = `import { fn${(index + 1) % GENERATED_FILES} } from '../pkg${((index + 1) % GENERATED_FILES) % 20}/file${(index + 1) % GENERATED_FILES}';\nexport function fn${index}(): number { return ${index}; }\nexport const use${index} = () => fn${(index + 1) % GENERATED_FILES};\n`;
    const big = await codeFixture({ files, maxFiles: MAX_FILES, policy: { maxFiles: 10_000 } });
    const deps = resolveCodeDeps({ options: big.options });
    const started = performance.now();
    const [entry] = entriesOf(await call({ tool: createCodeFindSymbol(deps), items: [{ name: 'fn1' }] }));
    expect(performance.now() - started).toBeLessThan(60_000);
    expect(entry?.result).toMatchObject({ incompleteIndex: true });
    await big.cleanup();
  }, 120_000);
});
