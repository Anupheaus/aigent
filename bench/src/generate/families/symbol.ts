import type { PlantContext } from '../plant-context.js';
import { compiledJs, markdownDoc } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { relativeImport } from '../paths.js';
import { camel, pascal } from '../vocabulary.js';
import { SOURCE_AREAS } from './string-target.js';

const QUERY = 'symbol';
const USERS = 3;

/** A function's definition and its usages (code and a test), against a mock, a longer name, comments, strings and docs. */
export function plantSymbol(ctx: PlantContext): void {
  const symbol = camel(['compute', ctx.freshWord(), 'totals']);
  ctx.term('symbol.name', symbol);
  const needle = (reason: string) => ({ kind: 'needle' as const, reason, answers: [QUERY], distinctive: [symbol] });
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [QUERY], distinctive: [symbol] });
  const definition = `src/${ctx.prng.pick(SOURCE_AREAS)}/${ctx.freshWord()}/totals.ts`;
  ctx.add({ path: definition, content: lines(`export function ${symbol}(amounts: number[]): { sum: number; count: number } {`, '  return { sum: amounts.reduce((total, amount) => total + amount, 0), count: amounts.length };', '}'), item: needle('definition') });
  for (let index = 0; index < USERS; index += 1) {
    const word = ctx.freshWord();
    const path = `src/${ctx.prng.pick(SOURCE_AREAS)}/${word}/${word}-summary.ts`;
    ctx.add({ path, content: lines(`import { ${symbol} } from '${relativeImport({ from: path, to: definition })}';`, '', `export function summarise${pascal(word)}(amounts: number[]): string {`, `  const { sum, count } = ${symbol}(amounts);`, '  return `${count} items, ${sum} total`;', '}'), item: needle('usage') });
    ctx.publicExport({ names: [`summarise${pascal(word)}`], file: path });
  }
  const testPath = definition.replace(/\.ts$/, '.test.ts');
  ctx.add({ path: testPath, content: lines("import { expect, it } from 'vitest';", `import { ${symbol} } from './totals';`, '', "it('sums', () => {", `  expect(${symbol}([1, 2]).sum).toBe(3);`, '});'), item: needle('usage in a test') });
  const legacyWord = ctx.freshWord();
  const legacyPath = `src/${ctx.prng.pick(SOURCE_AREAS)}/${legacyWord}/${legacyWord}-legacy.ts`;
  ctx.add({ path: legacyPath, content: lines(`export function ${symbol}Legacy(amounts: number[]): number {`, '  return amounts.length;', '}', '', `export const legacyCount = ${symbol}Legacy([1]);`), item: decoy('longer name defined and used') });
  ctx.add({ path: `${definition.slice(0, definition.lastIndexOf('/'))}/__mocks__/totals.ts`, content: lines(`export function ${symbol}(): { sum: number; count: number } {`, '  return { sum: 0, count: 0 };', '}'), item: decoy('mock with the same name') });
  ctx.publicExport({ names: [`${symbol}Legacy`], file: legacyPath });
  const logWord = ctx.freshWord();
  const auditPath = `src/${ctx.prng.pick(SOURCE_AREAS)}/${logWord}/${logWord}-audit.ts`;
  ctx.add({ path: auditPath, content: lines(`// Mirrors ${symbol} but counts refunds separately.`, `export function audit${pascal(logWord)}(log: (line: string) => void): void {`, `  log('${symbol} skipped');`, '}'), item: decoy('comment and string only') });
  ctx.publicExport({ names: [`audit${pascal(logWord)}`], file: auditPath });
  ctx.add({ path: `docs/${legacyWord}-totals.md`, content: markdownDoc({ title: 'Totals', paragraphs: [`Use \`${symbol}\` for totals.`] }), item: decoy('documentation') });
  ctx.add({ path: `dist/${legacyWord}/totals.js`, content: compiledJs({ source: lines(`export function ${symbol}(amounts) {`, '  return amounts.length;', '}') }), item: decoy('build output') });
}
