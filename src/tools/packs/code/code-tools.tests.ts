import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAigent } from '../../../core/create-aigent.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import { call, entriesOf } from '../fs/fs-tools.test-support.js';
import { createCodeFindSymbol } from './code-find-symbol.js';
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
