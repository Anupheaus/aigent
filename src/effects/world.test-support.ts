// Test-only in-memory "world" with mutating tools that support dry-run and undo. Excluded from the build, never exported.
import { z } from 'zod';
import { defineBatchTool, defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';

/** A tiny file system: path to content. */
export type World = Map<string, string>;

export function worldSnapshot(world: World): string {
  return JSON.stringify([...world.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

const pathArgs = z.object({ path: z.string() }).strict();
const writeArgs = z.object({ path: z.string(), content: z.string() }).strict();

/** Mutating tools over `world`: write, delete, a batch write, a mutating tool without dryRun, and a read-only read. */
export function worldTools(world: World): { write: Tool; remove: Tool; writeMany: Tool; unsafe: Tool; read: Tool; runs: string[] } {
  const runs: string[] = [];
  const write = defineTool({
    name: 'write_file', description: 'Write a file', args: writeArgs, deterministic: false, cache: false, hasSideEffects: true,
    describeActivity: ({ path }) => ({ title: `Writing ${path}` }),
    run: async ({ path, content }) => { runs.push(`write ${path}`); world.set(path, content); return { written: path }; },
    dryRun: async ({ path, content }) => [{ kind: 'file.write', target: path, summary: `write ${content.length} characters to ${path}`, ...(world.has(path) ? { before: world.get(path) } : {}), after: content, reversible: true }],
  });
  const remove = defineTool({
    name: 'delete_file', description: 'Delete a file', args: pathArgs, deterministic: false, cache: false, hasSideEffects: true,
    describeActivity: ({ path }) => ({ title: `Deleting ${path}` }),
    run: async ({ path }) => { runs.push(`delete ${path}`); const existed = world.delete(path); return { deleted: existed }; },
    dryRun: async ({ path }) => ({ result: { wouldDelete: world.has(path) }, effects: [{ kind: 'file.delete', target: path, summary: `delete ${path}`, reversible: true }] }),
  });
  const writeMany = defineBatchTool({
    name: 'write_files', description: 'Write files', item: writeArgs, maxItems: 10, deterministic: false, cache: false, hasSideEffects: true,
    describeActivity: ({ items }) => ({ title: `Writing ${items.length} files` }),
    runItem: async ({ path, content }) => { runs.push(`write ${path}`); world.set(path, content); return path; },
    dryRunItem: async ({ path }) => [{ kind: 'file.write', target: path, summary: `write ${path}`, reversible: true }],
  });
  const unsafe = defineTool({
    name: 'format_disk', description: 'Format', args: z.object({}).strict(), deterministic: false, cache: false, hasSideEffects: true,
    describeActivity: () => ({ title: 'Formatting' }), run: async () => { runs.push('format'); world.clear(); return 'formatted'; },
  });
  const read = defineTool({
    name: 'read_file', description: 'Read a file', args: pathArgs, deterministic: true, cache: true,
    describeActivity: ({ path }) => ({ title: `Reading ${path}` }), run: async ({ path }) => { runs.push(`read ${path}`); return world.get(path) ?? null; },
  });
  return { write, remove, writeMany, unsafe, read, runs };
}
