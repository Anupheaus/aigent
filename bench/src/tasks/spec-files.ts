import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tasksDir } from '../bench-paths.js';
import type { TaskSpec } from '../task-spec.js';

/** Spec files' text by name: one JSON file per catalogue task, specs in id order (byte-stable). */
export function specFileTexts(specs: TaskSpec[]): Map<string, string> {
  const byFamily = new Map<string, TaskSpec[]>();
  for (const spec of [...specs].sort((first, second) => first.id.localeCompare(second.id))) byFamily.set(spec.family, [...(byFamily.get(spec.family) ?? []), spec]);
  return new Map([...byFamily.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([family, list]) => [`${family}.json`, `${JSON.stringify(list, null, 2)}\n`]));
}

export async function writeSpecs(params: { specs: TaskSpec[]; dir?: string }): Promise<string[]> {
  const { specs, dir = tasksDir() } = params;
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, text] of specFileTexts(specs)) { await writeFile(`${dir}/${name}`, text, 'utf8'); written.push(name); }
  return written;
}

/** Every committed spec (held-out ones included; callers filter). */
export async function readSpecs(dir: string = tasksDir()): Promise<TaskSpec[]> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  const specs: TaskSpec[] = [];
  for (const name of names) specs.push(...JSON.parse(await readFile(`${dir}/${name}`, 'utf8')) as TaskSpec[]);
  return specs;
}
