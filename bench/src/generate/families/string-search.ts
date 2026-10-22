import type { PlantContext } from '../plant-context.js';
import type { RepoSize } from '../repo-types.js';
import { compiledJs, minifiedBundle } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { camel, pascal } from '../vocabulary.js';
import { ALL_STRING_DECOYS, plantStringTarget, SOURCE_AREAS } from './string-target.js';
import { plantNoisyTarget } from './noisy-target.js';

const FIELD_NOUNS = ['tier', 'grade', 'weight', 'factor', 'margin', 'rank', 'bias', 'offset'];
const FIELD_ENDINGS = ['code', 'level', 'score', 'band'];
const USAGE_NEEDLES: Record<RepoSize, number> = { small: 4, medium: 6, large: 8, huge: 10 };

/** An identifier such as `cedarTierCode` that no filler file contains. */
export function freshIdentifier(ctx: PlantContext): string {
  return camel([ctx.freshWord(), ctx.prng.pick(FIELD_NOUNS), ctx.prng.pick(FIELD_ENDINGS)]);
}

/** Mentions of one concept in every spelling (camel, snake, Pascal, kebab) and in every kind of text file. */
function plantAnyCase(ctx: PlantContext): void {
  const words = [ctx.freshWord(), ctx.prng.pick(FIELD_NOUNS), ctx.prng.pick(FIELD_ENDINGS)];
  const identifier = camel(words);
  ctx.term('string-any-case.identifier', identifier);
  const query = 'string-any-case';
  const needle = (reason: string) => ({ kind: 'needle' as const, reason, answers: [query], distinctive: [identifier] });
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [query], distinctive: [identifier] });
  const dir = `src/${ctx.prng.pick(SOURCE_AREAS)}/${ctx.freshWord()}`;
  const reader = `read${pascal(words[0] ?? 'x')}`;
  ctx.add({ path: `${dir}/${words[0]}-model.ts`, content: lines(`export function ${reader}(row: Record<string, number>): number {`, `  return row.${identifier} ?? 0;`, '}'), item: needle('camelCase in code') });
  ctx.publicExport({ names: [reader], file: `${dir}/${words[0]}-model.ts` });
  ctx.add({ path: `migrations/${words[0]}-${words[1]}.sql`, content: lines(`ALTER TABLE accounts ADD COLUMN ${words.join('_')} INTEGER;`), item: needle('snake_case in SQL') });
  ctx.add({ path: `${dir}/${words[0]}-types.ts`, content: lines(`export type ${words.map(pascal).join('')} = number;`), item: needle('PascalCase type') });
  ctx.add({ path: `${dir}/${words[0]}.css`, content: lines(`.${words.join('-')} {`, '  color: inherit;', '}'), item: needle('kebab-case CSS class') });
  ctx.add({ path: `docs/${words[0]}-${words[2]}.md`, content: lines(`# Notes`, '', `The ${words.join('_')} column backs the \`${identifier}\` field.`), item: needle('documentation') });
  ctx.add({ path: `${dir}/${words[0]}.test.ts`, content: lines("import { expect, it } from 'vitest';", '', `it('defaults ${identifier}', () => {`, `  expect({ ${identifier}: 0 }.${identifier}).toBe(0);`, '});'), item: needle('test') });
  ctx.add({ path: `${dir}/${words[0]}-label.ts`, content: lines(`// Label for ${identifier} in the admin screens.`, `export const ${identifier}Label = 'Level';`), item: needle('comment and longer identifier') });
  ctx.add({ path: `dist/${words[0]}/${words[0]}-model.js`, content: compiledJs({ source: lines(`export function ${reader}(row) {`, `  return row.${identifier};`, '}') }), item: decoy('build output') });
  ctx.add({ path: `vendor/${words[0]}-${words[1]}.min.js`, content: minifiedBundle({ library: words[0] ?? 'x', names: [identifier], filler: 10 }), item: decoy('vendored minified bundle') });
  const nearMiss = camel([words[0] ?? 'x', `${words[1]}s`, words[2] === 'code' ? 'coda' : 'code']);
  ctx.add({ path: `${dir}/${words[0]}-near.ts`, content: lines(`export const ${nearMiss} = 1;`, `export const ${camel([words[0] ?? 'x', words[1] ?? 'x'])} = 2;`), item: decoy('near-miss spellings') });
}

/** Whole-word mentions (code, comments, strings, docs, tests) against longer identifiers and other cases. */
function plantWordTarget(ctx: PlantContext): void {
  const words = [ctx.freshWord(), ctx.prng.pick(FIELD_NOUNS)];
  const identifier = camel(words);
  ctx.term('string-word.identifier', identifier);
  const query = 'string-word';
  const needle = (reason: string) => ({ kind: 'needle' as const, reason, answers: [query], distinctive: [identifier] });
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [query], distinctive: [identifier] });
  const dir = `src/${ctx.prng.pick(SOURCE_AREAS)}/${ctx.freshWord()}`;
  const word = words[0] ?? 'x';
  ctx.add({ path: `${dir}/${word}-rules.ts`, content: lines(`export const ${identifier} = 3;`), item: needle('declaration') });
  ctx.add({ path: `${dir}/${word}-notes.ts`, content: lines(`// Keep ${identifier} in step with the pricing sheet.`, 'export const notes = [];'), item: needle('comment') });
  ctx.add({ path: `${dir}/${word}-message.ts`, content: lines(`export const message = 'Set ${identifier} first';`), item: needle('string literal') });
  ctx.add({ path: `docs/${word}-guide.md`, content: lines('# Guide', '', `Change ${identifier} in the admin screen.`), item: needle('documentation') });
  ctx.add({ path: `${dir}/${word}-extended.ts`, content: lines(`export const ${identifier}Table = [1, 2];`, `export const ${identifier}2 = 4;`), item: decoy('longer identifiers') });
  ctx.add({ path: `${dir}/${word}-constants.ts`, content: lines(`export const ${words.map(part => part.toUpperCase()).join('_')} = 3;`, `export const ${pascal(identifier)}Kind = 'x';`), item: decoy('other case') });
  ctx.add({ path: `dist/${word}/${word}-rules.js`, content: compiledJs({ source: lines(`export const ${identifier} = 3;`) }), item: decoy('build output') });
}

/** The string-search family: exact usage, any case, whole word and a noisy common call. */
export function plantStringSearch(ctx: PlantContext): void {
  const identifier = freshIdentifier(ctx);
  ctx.term('string-usage.identifier', identifier);
  plantStringTarget({ ctx, target: { query: 'string-usage', identifier, needles: USAGE_NEEDLES[ctx.size], decoys: ALL_STRING_DECOYS } });
  plantAnyCase(ctx);
  plantWordTarget(ctx);
  plantNoisyTarget(ctx);
}
