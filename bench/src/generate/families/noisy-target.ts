import type { PlantContext } from '../plant-context.js';
import type { RepoSize } from '../repo-types.js';
import { compiledJs, cssFile, markdownDoc } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { relativeImport } from '../paths.js';
import { pascal } from '../vocabulary.js';
import { SOURCE_AREAS } from './string-target.js';

const NOISY_VERBS = ['track', 'publish', 'notify'];
const CALLERS: Record<RepoSize, number> = { small: 3, medium: 5, large: 7, huge: 9 };
/** Files that merely contain the common word: the noise that makes the obvious first search useless. */
const NOISE_FILES: Record<RepoSize, number> = { small: 24, medium: 160, large: 600, huge: 1_400 };

/** Noise file `index`: the verb inside longer words, other modules' own functions, styles, data and prose. */
function noiseFile(params: { verb: string; index: number; word: string }): { path: string; content: string; isCode: boolean } {
  const { verb, index, word } = params;
  const slot = `${word}${index}`;
  switch (index % 5) {
    case 0: return { path: `src/geo/${slot}-path.ts`, content: lines(`function ${verb}(points: number[]): number {`, '  return points.length;', '}', '', `export const ${verb}${pascal(slot)}Length = ${verb}([1, 2, 3]);`), isCode: true };
    case 1: return { path: `src/content/${slot}.json`, content: `${JSON.stringify({ [verb]: `${slot}-${index}`, [`${verb}ing`]: true }, null, 2)}\n`, isCode: false };
    case 2: return { path: `src/styles/${slot}.css`, content: cssFile({ selector: `${verb}-${slot}`, gap: 4 }), isCode: false };
    case 3: return { path: `docs/notes/${slot}.md`, content: markdownDoc({ title: slot, paragraphs: [`Remember to ${verb} the ${slot} handover in the weekly notes.`] }), isCode: false };
    default: return { path: `src/models/${slot}-${verb}er.ts`, content: lines(`export interface ${pascal(slot)}${pascal(verb)}er {`, `  ${verb}ingId: string;`, `  last${pascal(verb)}At: string;`, '}'), isCode: true };
  }
}

/** A common call (`track(...)` imported from the analytics module) hidden among thousands of matches of the word. */
export function plantNoisyTarget(ctx: PlantContext): void {
  const query = 'string-noisy';
  const verb = ctx.prng.pick(NOISY_VERBS);
  ctx.term('string-noisy.verb', verb);
  const analytics = `src/${ctx.prng.pick(SOURCE_AREAS)}/${ctx.freshWord()}/analytics.ts`;
  ctx.add({ path: analytics, content: lines(`export function ${verb}(event: string, data: Record<string, unknown> = {}): void {`, '  globalThis.dispatchEvent?.(new CustomEvent(event, { detail: data }));', '}'), item: { kind: 'decoy', reason: 'defines the call, does not make it', decoyFor: [query] } });
  for (let index = 0; index < CALLERS[ctx.size]; index += 1) {
    const name = ctx.freshWord();
    const path = `src/${ctx.prng.pick(SOURCE_AREAS)}/${name}/${name}-flow.ts`;
    ctx.add({
      path,
      content: lines(`import { ${verb} } from '${relativeImport({ from: path, to: analytics })}';`, '', `export function finish${pascal(name)}(id: string): void {`, `  ${verb}('${name}-finished', { id });`, '}'),
      item: { kind: 'needle', reason: 'calls the analytics function', answers: [query] },
    });
    ctx.publicExport({ names: [`finish${pascal(name)}`], file: path });
    if (index === 0) {
      ctx.add({ path: `src/${path.split('/')[1]}/${name}/${name}-flow.test.ts`, content: lines("import { vi, it } from 'vitest';", `import { ${verb} } from '${relativeImport({ from: path, to: analytics })}';`, '', `it('${verb}s', () => {`, `  ${verb}('test-event');`, `  vi.fn(${verb});`, '});'), item: { kind: 'decoy', reason: 'test call', decoyFor: [query] } });
      ctx.add({ path: `dist/${name}/${name}-flow.js`, content: compiledJs({ source: lines(`export function finish(id) {`, `  ${verb}('done', { id });`, '}') }), item: { kind: 'decoy', reason: 'build output', decoyFor: [query] } });
    }
  }
  const word = ctx.freshWord();
  for (let index = 0; index < NOISE_FILES[ctx.size]; index += 1) {
    const { path, content, isCode } = noiseFile({ verb, index, word });
    ctx.add({ path, content, ...(index < 5 ? { item: { kind: isCode ? 'decoy' : 'noise', reason: 'contains the word but makes no analytics call', decoyFor: [query] } } : {}) });
  }
}
