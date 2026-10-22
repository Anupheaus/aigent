import type { PlantContext } from '../plant-context.js';
import type { RepoSize } from '../repo-types.js';
import { lines } from '../file-templates/text.js';
import { componentFile, componentTest, storyFile } from '../file-templates/tsx.js';
import { NAME_SUFFIXES, pascal } from '../vocabulary.js';

const QUERY = 'react';
const COMPONENTS: Record<RepoSize, number> = { small: 5, medium: 7, large: 9, huge: 11 };

/** A real component (function declaration or arrow) in its own folder; returns its name and path. */
function plantComponent(params: { ctx: PlantContext; position: number }): { name: string; path: string; dir: string } {
  const { ctx, position } = params;
  const word = ctx.freshWord();
  const name = `${pascal(word)}${ctx.prng.pick(NAME_SUFFIXES)}`;
  const dir = `src/ui/${word}`;
  const path = `${dir}/${name}.tsx`;
  ctx.add({
    path,
    content: componentFile({ name, props: ['title: string', 'count?: number'], style: position % 2 === 0 ? 'function' : 'arrow', body: ['    <section className="card">', '      <h2>{title}</h2>', '      <p>{count ?? 0} items</p>', '    </section>'] }),
    item: { kind: 'needle', reason: 'a React function component', answers: [QUERY] },
  });
  ctx.publicExport({ names: [name], file: path });
  return { name, path, dir };
}

/**
 * The React family: real components (declarations and arrows) against stories, mocks, tests, a hook, a higher-order
 * component, a function returning markup as a string and a class named like a component.
 */
export function plantReact(ctx: PlantContext): void {
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [QUERY] });
  const components = Array.from({ length: COMPONENTS[ctx.size] }, (_unused, position) => plantComponent({ ctx, position }));
  const [first, second] = components;
  if (first == null || second == null) return;
  ctx.slot({ name: first.name, file: first.path });
  ctx.add({ path: `${first.dir}/${first.name}.stories.tsx`, content: storyFile({ name: first.name, module: first.name, args: 'title="Story"' }), item: decoy('Storybook story') });
  ctx.add({ path: `${second.dir}/${second.name}.test.tsx`, content: componentTest({ name: second.name, module: second.name, args: 'title="Test"' }), item: decoy('component test') });
  ctx.add({ path: `src/ui/__mocks__/${second.name}.tsx`, content: lines(`export const ${second.name} = () => <div data-testid="mock" />;`), item: decoy('mock component') });
  const hookWord = ctx.freshWord();
  const hook = `use${pascal(hookWord)}`;
  ctx.add({ path: `src/ui/hooks/${hook}.ts`, content: lines("import { useState } from 'react';", '', `export function ${hook}(initial: number) {`, '  const [value, setValue] = useState(initial);', '  return { value, increment: () => setValue(value + 1) };', '}'), item: decoy('hook, renders nothing') });
  ctx.publicExport({ names: [hook], file: `src/ui/hooks/${hook}.ts` });
  const hocWord = pascal(ctx.freshWord());
  const hoc = `with${hocWord}`;
  ctx.add({
    path: `src/ui/hocs/${hoc}.tsx`,
    content: lines("import type { ComponentType } from 'react';", '', `export function ${hoc}<P extends object>(Wrapped: ComponentType<P>) {`, `  return function With${hocWord}(props: P) {`, '    return <Wrapped {...props} />;', '  };', '}'),
    item: decoy('higher-order component (returns a component)'),
  });
  ctx.publicExport({ names: [hoc], file: `src/ui/hocs/${hoc}.tsx` });
  const markupWord = pascal(ctx.freshWord());
  const markup = `${markupWord}Markup`;
  ctx.add({ path: `src/lib/markup/${markup}.tsx`, content: lines(`export function ${markup}(label: string): string {`, `  return '<div class="tile">' + label + '</div>';`, '}'), item: decoy('returns JSX-like markup as a string') });
  ctx.publicExport({ names: [markup], file: `src/lib/markup/${markup}.tsx` });
  const toolbarWord = pascal(ctx.freshWord());
  ctx.add({ path: `src/lib/${toolbarWord}Toolbar.ts`, content: lines(`export class ${toolbarWord}Toolbar {`, '  static widthFor(count: number): number {', '    return count * 32;', '  }', '}'), item: decoy('class named like a component, a plain utility') });
}
