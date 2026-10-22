import type { PlantContext } from './plant-context.js';
import { compiledJs, markdownDoc } from './file-templates/assets.js';
import { lines } from './file-templates/text.js';
import { utilityModule } from './file-templates/ts.js';
import { pascal } from './vocabulary.js';

/**
 * Look-alikes of a file named `<stem>.ts`: old and backup copies, a test, a snapshot, build output, docs and a
 * PascalCase twin. (Each family's other decoys live with its planter; these are shared by the name-finding tasks.)
 */
export function plantNameDecoys(params: { ctx: PlantContext; stem: string; dir: string; query: string }): void {
  const { ctx, stem, dir, query } = params;
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [query] });
  ctx.add({ path: `${dir}/${stem}.old.ts`, content: lines('// Previous version, kept for reference until the migration is finished.', 'export {};'), item: decoy('old copy with a similar name') });
  ctx.add({ path: `src/archive/${stem}.backup.ts`, content: lines('// Backup taken before the refactor.', 'export {};'), item: decoy('backup copy') });
  ctx.add({ path: `${dir}/${stem}.test.ts`, content: lines("import { expect, it } from 'vitest';", `import { build${pascal(stem)} } from './${stem}';`, '', "it('sums weights', () => {", `  expect(build${pascal(stem)}([{ key: 'a', weight: 2 }]).get('a')).toBe(2);`, '});'), item: decoy('test file named after it') });
  ctx.add({ path: `${dir}/__snapshots__/${stem}.test.ts.snap`, content: lines('// Vitest Snapshot v1', '', `exports[\`${stem} 1\`] = \`Map {}\`;`), item: decoy('snapshot named after it') });
  ctx.add({ path: `dist/${dir.replace(/^src\//, '')}/${stem}.js`, content: compiledJs({ source: utilityModule({ stem }) }), item: decoy('build output copy') });
  ctx.add({ path: `docs/${stem}.md`, content: markdownDoc({ title: stem, paragraphs: ['Notes about how weights are summed.'] }), item: decoy('documentation named after it') });
  ctx.add({ path: `src/legacy/${pascal(stem)}.ts`, content: lines('// Superseded: kept for older imports.', 'export {};'), item: decoy('same name in another case') });
}
