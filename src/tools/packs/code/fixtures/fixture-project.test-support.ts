// Test-only fixture project for the code pack, written to a temp directory at test time. Excluded from the build.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Relative path → content. Covers merging, overloads, default exports, re-export chains, aliased imports and members. */
export const FIXTURE_FILES: Record<string, string> = {
  'src/shapes.ts': [
    '/** Shapes. */',
    'export interface Shape { area(): number }',
    'export interface Shape { name: string }',
    'export namespace Shape { export const unit = 1; }',
    'export class Circle implements Shape {',
    "  name = 'circle';",
    '  constructor(private readonly radius: number) {}',
    '  area(): number { return Math.PI * this.radius ** 2; }',
    '  get diameter(): number { return this.radius * 2; }',
    '}',
    'export function scale(shape: Shape): number;',
    'export function scale(shape: Shape, factor: number): number;',
    'export function scale(shape: Shape, factor = 1): number { return shape.area() * factor; }',
    'export enum Color { Red, Green }',
    'export type Pair = [number, number];',
    'const hidden = 2;',
    'export default function describe(shape: Shape): string { return shape.name + hidden; }',
    '',
  ].join('\n'),
  'src/index.ts': "export { scale as resize, Circle } from './shapes';\nexport * from './util';\n",
  'src/util.ts': 'export const PI2 = Math.PI * 2;\nexport function helper(): number { return PI2; }\n',
  'src/app.ts': [
    "import { resize, Circle as Round } from './index';",
    "import describe, { scale } from './shapes';",
    "import { helper } from './util';",
    'const circle = new Round(2);',
    'export const total = resize(circle, 2) + helper() + scale(circle);',
    'describe(circle);',
    '',
  ].join('\n'),
  'src/legacy.js': 'function old() { return 1; }\nmodule.exports = { old };\n',
  'src/view.tsx': 'export const View = (props: { title: string }) => props.title;\n',
  'node_modules/dep/index.ts': 'export function scale(): void {}\n',
  'README.md': '# Not code\n',
};

/** Writes the files under `root`. */
export async function writeProject(params: { root: string; files?: Record<string, string> }): Promise<void> {
  const { root, files = FIXTURE_FILES } = params;
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
