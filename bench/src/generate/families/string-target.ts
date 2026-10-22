import type { PlantContext } from '../plant-context.js';
import { compiledJs, markdownDoc, minifiedBundle } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { pascal } from '../vocabulary.js';

/** Areas planted source files spread over. */
export const SOURCE_AREAS = ['lib', 'core', 'shared', 'domain', 'utils'] as const;

/** Decoy kinds every identifier target can plant. */
export type StringDecoyKind = 'comment' | 'docs' | 'test' | 'snapshot' | 'dist' | 'minified' | 'lockfile' | 'casing' | 'superstring' | 'string-literal';

export const ALL_STRING_DECOYS: readonly StringDecoyKind[] = ['comment', 'docs', 'test', 'snapshot', 'dist', 'minified', 'lockfile', 'casing', 'superstring', 'string-literal'];

const snake = (identifier: string): string => identifier.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

/** A source file using `identifier` in code, in one of four shapes (field, read, destructure, assignment in plain JS). */
function needleSource(params: { identifier: string; name: string; shape: number }): { extension: string; content: string; exported: string | undefined } {
  const { identifier, name, shape } = params;
  const type = `${pascal(name)}Profile`;
  if (shape === 0) return { extension: 'ts', content: lines(`export interface ${type} {`, '  id: string;', `  ${identifier}: string;`, '}'), exported: undefined };
  if (shape === 1) return { extension: 'ts', content: lines(`export function read${pascal(name)}(record: { ${identifier}?: string }): string {`, `  return record.${identifier} ?? 'none';`, '}'), exported: `read${pascal(name)}` };
  if (shape === 2) return { extension: 'ts', content: lines(`export function pick${pascal(name)}(input: Record<string, string>): string {`, `  const { ${identifier} } = input;`, `  return String(${identifier});`, '}'), exported: `pick${pascal(name)}` };
  return { extension: 'js', content: lines(`export function apply${pascal(name)}(target, value) {`, `  target.${identifier} = value;`, '  return target;', '}'), exported: `apply${pascal(name)}` };
}

export interface StringTargetParams {
  /** The truth query these files answer (`string-usage`, `trap-injection`...). */
  query: string;
  identifier: string;
  needles: number;
  decoys: readonly StringDecoyKind[];
}

/** Plants `identifier` used in code by `needles` source files, plus the requested decoys; returns the needle paths. */
export function plantStringTarget(params: { ctx: PlantContext; target: StringTargetParams }): string[] {
  const { ctx, target: { query, identifier, needles, decoys } } = params;
  const paths: string[] = [];
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [query], distinctive: [identifier] });
  for (let position = 0; position < needles; position += 1) {
    const name = ctx.freshWord();
    const source = needleSource({ identifier, name, shape: position % 4 });
    const path = `src/${ctx.prng.pick(SOURCE_AREAS)}/${name}/${name}-${['fields', 'reader', 'picker', 'apply'][position % 4]}.${source.extension}`;
    ctx.add({ path, content: source.content, item: { kind: 'needle', reason: 'uses the identifier in code', answers: [query], distinctive: [identifier] } });
    if (source.exported != null) ctx.publicExport({ names: [source.exported], file: path });
    paths.push(path);
  }
  const home = paths[0]?.replace(/\/[^/]+$/, '') ?? `src/lib/${ctx.freshWord()}`;
  const word = ctx.freshWord();
  const has = (kind: StringDecoyKind): boolean => decoys.includes(kind);
  if (has('comment')) {
    const path = `${home}/${word}-forward.ts`;
    ctx.add({ path, content: lines(`// ${identifier} is filled in upstream; this module only forwards the record.`, `export function forward${pascal(word)}<T>(record: T): T {`, '  return record;', '}'), item: decoy('mentioned only in a comment') });
    ctx.publicExport({ names: [`forward${pascal(word)}`], file: path });
  }
  if (has('docs')) ctx.add({ path: `docs/${word}-fields.md`, content: markdownDoc({ title: `${pascal(word)} fields`, paragraphs: [`The \`${identifier}\` field is optional.`] }), item: decoy('documentation mention') });
  if (has('test')) ctx.add({ path: `${home}/${word}.test.ts`, content: lines("import { expect, it } from 'vitest';", '', "it('keeps the field', () => {", `  const record = { ${identifier}: 'gold' };`, `  expect(record.${identifier}).toBe('gold');`, '});'), item: decoy('used only in a test') });
  if (has('snapshot')) ctx.add({ path: `${home}/__snapshots__/${word}.test.ts.snap`, content: lines('// Vitest Snapshot v1', '', `exports[\`${word} 1\`] = \`{ "${identifier}": "gold" }\`;`), item: decoy('snapshot') });
  if (has('dist')) ctx.add({ path: `dist/${word}/${word}-build.js`, content: compiledJs({ source: lines(`export function read${pascal(word)}(record) {`, `  return record.${identifier};`, '}') }), item: decoy('build output') });
  if (has('minified')) ctx.add({ path: `vendor/${word}.min.js`, content: minifiedBundle({ library: word, names: [identifier], filler: 20 }), item: decoy('vendored minified bundle') });
  if (has('lockfile')) ctx.add({ path: `packages/${word}/yarn.lock`, content: lines('# yarn lockfile v1', '', `"${word}-${identifier}@^1.0.0":`, '  version "1.0.0"'), item: decoy('lockfile') });
  if (has('casing')) {
    ctx.add({ path: `migrations/${word}.sql`, content: lines(`ALTER TABLE profiles ADD COLUMN ${snake(identifier)} TEXT;`), item: decoy('snake_case spelling') });
    const path = `src/${ctx.prng.pick(SOURCE_AREAS)}/${word}/${word}-types.ts`;
    ctx.add({ path, content: lines(`export type ${pascal(identifier)} = 'bronze' | 'silver' | 'gold';`), item: decoy('PascalCase spelling') });
  }
  if (has('superstring')) {
    const path = `src/${ctx.prng.pick(SOURCE_AREAS)}/${word}/${word}-label.ts`;
    ctx.add({ path, content: lines(`export const ${identifier}Label = 'Tier';`, `export const ${identifier}Hint = 'Shown on the profile page';`), item: decoy('longer identifier containing it') });
  }
  if (has('string-literal')) {
    const path = `src/${ctx.prng.pick(SOURCE_AREAS)}/${word}/${word}-log.ts`;
    ctx.add({ path, content: lines(`export function warn${pascal(word)}(log: (message: string) => void): void {`, `  log('${identifier} was missing from the payload');`, '}'), item: decoy('inside a string literal only') });
    ctx.publicExport({ names: [`warn${pascal(word)}`], file: path });
  }
  return paths;
}
