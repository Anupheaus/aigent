import type { PlantContext } from '../plant-context.js';
import { lines } from '../file-templates/text.js';
import { helperModule } from '../file-templates/ts.js';
import { relativeImport } from '../paths.js';
import { camel } from '../vocabulary.js';

const VERBS = ['scale', 'clamp', 'shift', 'blend', 'round', 'pad', 'trim', 'fold'];

/**
 * Exported helpers nobody uses (the answer) beside ones used only by a test, through a dynamic import or a re-export,
 * and dead ones that only look used (named in a comment, or a prefix of a longer used name).
 */
export function plantDeadExports(ctx: PlantContext): void {
  const word = ctx.freshWord();
  const dir = `src/lib/${ctx.freshWord()}`;
  const path = `${dir}/${word}-helpers.ts`;
  const [dead1, dead2, dead3, byTest, byDynamic, byReexport] = ctx.prng.shuffle(VERBS).slice(0, 6).map(verb => camel([verb, word]));
  if (dead1 == null || dead2 == null || dead3 == null || byTest == null || byDynamic == null || byReexport == null) return;
  ctx.add({ path, content: helperModule({ names: [dead1, byTest, dead2, byDynamic, dead3, byReexport] }), item: { kind: 'needle', reason: 'declares the dead exports', distinctive: [dead1, dead2, dead3] } });
  ctx.add({ path: `${dir}/${word}-helpers.test.ts`, content: lines("import { expect, it } from 'vitest';", `import { ${byTest} } from './${word}-helpers';`, '', "it('doubles', () => {", `  expect(${byTest}(2)).toBe(6);`, '});'), item: { kind: 'decoy', reason: 'keeps one helper alive from a test', decoyFor: ['dead-exports'] } });
  const lazyPath = `src/app/lazy-${word}.ts`;
  ctx.add({ path: lazyPath, content: lines(`export async function load${word[0]?.toUpperCase()}${word.slice(1)}(): Promise<number> {`, `  const helpers = await import('${relativeImport({ from: lazyPath, to: path })}');`, `  return helpers.${byDynamic}(1);`, '}'), item: { kind: 'decoy', reason: 'keeps one helper alive through a dynamic import', decoyFor: ['dead-exports'] } });
  ctx.publicExport({ names: [`load${word[0]?.toUpperCase()}${word.slice(1)}`], file: lazyPath });
  ctx.publicExport({ names: [byReexport], file: path });
  const notePath = `src/app/notes-${word}.ts`;
  ctx.add({ path: notePath, content: lines(`// ${dead1} used to be called here before the rewrite.`, `export const ${dead2}Enabled = false;`), item: { kind: 'decoy', reason: 'names dead helpers in a comment and a longer identifier', decoyFor: ['dead-exports'] } });
  ctx.criteria('dead-exports', { required: [dead1, dead2, dead3].sort(), forbidden: [byTest, byDynamic, byReexport].sort() });
}
