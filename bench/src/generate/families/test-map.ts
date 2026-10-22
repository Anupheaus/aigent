import type { PlantContext } from '../plant-context.js';
import { markdownDoc } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { relativeImport } from '../paths.js';
import { camel, pascal } from '../vocabulary.js';
import { utilityModule } from '../file-templates/ts.js';

const QUERY = 'tests-for';

const testSource = (params: { stem: string; specifier: string }): string => lines(
  "import { expect, it } from 'vitest';",
  `import { build${pascal(params.stem)} } from '${params.specifier}';`,
  '',
  "it('keeps the heaviest key', () => {",
  `  expect(build${pascal(params.stem)}([{ key: 'k', weight: 3 }]).get('k')).toBe(3);`,
  '});',
);

/** A module with its tests in three places (beside it, `__tests__`, an integration folder) and look-alike tests. */
export function plantTestMap(ctx: PlantContext): void {
  const stem = camel([ctx.freshWord(), 'rollup']);
  const dir = `src/lib/${ctx.freshWord()}`;
  const module = `${dir}/${stem}.ts`;
  ctx.add({ path: module, content: utilityModule({ stem }), item: { kind: 'noise', reason: 'the module whose tests are asked for' } });
  ctx.publicExport({ names: [`build${pascal(stem)}`], file: module });
  ctx.term('tests-for.module', `${stem}.ts`);
  ctx.term('tests-for.path', module);
  const needle = (reason: string) => ({ kind: 'needle' as const, reason, answers: [QUERY] });
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [QUERY] });
  const beside = `${dir}/${stem}.test.ts`;
  ctx.add({ path: beside, content: testSource({ stem, specifier: `./${stem}` }), item: needle('test beside the module') });
  const nested = `${dir}/__tests__/${stem}.edge.test.ts`;
  ctx.add({ path: nested, content: testSource({ stem, specifier: relativeImport({ from: nested, to: module }) }), item: needle('test in __tests__') });
  const integration = `tests/integration/${ctx.freshWord()}.spec.ts`;
  ctx.add({ path: integration, content: testSource({ stem, specifier: relativeImport({ from: integration, to: module }) }), item: needle('integration test importing it') });
  const sibling = `${dir}/${stem}-format.ts`;
  const siblingStem = `${stem}Format`;
  ctx.add({ path: sibling, content: utilityModule({ stem: siblingStem }) });
  ctx.publicExport({ names: [`build${pascal(siblingStem)}`], file: sibling });
  ctx.add({ path: `${dir}/${stem}-format.test.ts`, content: testSource({ stem: siblingStem, specifier: `./${stem}-format` }), item: decoy('tests a similarly named module') });
  const legacyDir = `src/legacy/${ctx.freshWord()}`;
  const legacy = `${legacyDir}/${stem}-legacy.ts`;
  const legacyStem = `${stem}Legacy`;
  ctx.add({ path: legacy, content: utilityModule({ stem: legacyStem }) });
  ctx.publicExport({ names: [`build${pascal(legacyStem)}`], file: legacy });
  ctx.add({ path: `${legacyDir}/${stem}.test.ts`, content: testSource({ stem: legacyStem, specifier: `./${stem}-legacy` }), item: decoy('named like its test, tests another module') });
  ctx.add({ path: `${dir}/__snapshots__/${stem}.test.ts.snap`, content: lines('// Vitest Snapshot v1', '', `exports[\`${stem} 1\`] = \`Map {}\`;`), item: decoy('snapshot') });
  ctx.add({ path: `docs/testing-${stem}.md`, content: markdownDoc({ title: 'Testing', paragraphs: [`The ${stem} tests run in CI.`] }), item: decoy('documentation') });
}
