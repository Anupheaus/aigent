// Test-only in-memory "world" with mutating tools that support dry-run and undo. Excluded from the build, never exported.
import { z } from 'zod';
import { defineTool } from '../tools/define-tool.js';
import { defineBatchTool } from '../tools/define-batch-tool.js';
import type { Tool } from '../tools/tool-types.js';

/** A tiny file system: path to content. */
export type World = Map<string, string>;

export function worldSnapshot(world: World): string {
  return JSON.stringify([...world.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

/** Puts a path back as it was; the path `/fail` cannot be restored (a failing undo). */
async function restore(params: { world: World; descriptor: Record<string, unknown>; undone: string[] }): Promise<{ ok: boolean; message?: string }> {
  const { world, descriptor, undone } = params;
  const { path, previous } = descriptor as { path: string; previous: string | null };
  if (path === '/fail') throw new Error(`cannot restore ${path}`);
  undone.push(path);
  if (previous === null) world.delete(path);
  else world.set(path, previous);
  return { ok: true };
}

const pathArgs = z.object({ path: z.string() }).strict();
const writeArgs = z.object({ path: z.string(), content: z.string() }).strict();

/** Mutating tools over `world`: write, delete, a batch write, a mutating tool without dryRun, and a read-only read. */
export function worldTools(world: World): { write: Tool; remove: Tool; writeMany: Tool; unsafe: Tool; read: Tool; runs: string[]; undone: string[] } {
  const runs: string[] = [];
  /** Paths whose undo was applied, in order. */
  const undone: string[] = [];
  const write = defineTool({
    name: 'write_file', description: 'Write a file', args: writeArgs, deterministic: false, cache: false, hasSideEffects: true,
    describeActivity: ({ path }) => ({ title: `Writing ${path}` }),
    run: async ({ path, content }) => { runs.push(`write ${path}`); const previous = world.get(path) ?? null; world.set(path, content); return { written: path, previous }; },
    undo: async ({ path }, result) => ({ path, previous: (result as { previous: string | null }).previous }),
    applyUndo: async descriptor => restore({ world, descriptor, undone }),
    dryRun: async ({ path, content }) => [{ kind: 'file.write', target: path, summary: `write ${content.length} characters to ${path}`, ...(world.has(path) ? { before: world.get(path) } : {}), after: content, reversible: true }],
  });
  const remove = defineTool({
    name: 'delete_file', description: 'Delete a file', args: pathArgs, deterministic: false, cache: false, hasSideEffects: true,
    describeActivity: ({ path }) => ({ title: `Deleting ${path}` }),
    run: async ({ path }) => { runs.push(`delete ${path}`); const previous = world.get(path) ?? null; world.delete(path); return { deleted: previous != null, previous }; },
    undo: async ({ path }, result) => ({ path, previous: (result as { previous: string | null }).previous }),
    applyUndo: async descriptor => restore({ world, descriptor, undone }),
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
  return { write, remove, writeMany, unsafe, read, runs, undone };
}
