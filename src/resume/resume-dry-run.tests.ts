import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/define-tool.js';
import type { Tool, ToolResumePolicy } from '../tools/tool-types.js';
import { crashableStore, createInMemoryStore, definitionFor, LEASE_TTL_MS, runtimeOver, scriptedProvider } from './crash-injection.test-support.js';

const TASK = { task: 'Save two notes and read a.txt', unattended: true, dryRun: true };

interface Counts {
  /** Real executions of the tool body: a dry run must never reach it. */
  ran: string[];
  simulated: string[];
}

/** `save_note` with a `dryRun`; the first process dies inside the simulation of the first note. */
function noteTools(params: { resume: ToolResumePolicy; counts: Counts; crash?(): void }): Tool[] {
  const { resume, counts, crash } = params;
  const saveNote = defineTool({
    name: 'save_note', description: 'Save a note', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true, resume,
    ...(resume === 'verify' ? { verify: async () => ({ done: false }) } : {}),
    describeActivity: () => ({ title: 'save' }),
    dryRun: async ({ text }) => {
      counts.simulated.push(text);
      if (text === 'first') crash?.();
      return [{ kind: 'note.write', target: text, summary: `save ${text}`, reversible: true }];
    },
    run: async ({ text }) => { counts.ran.push(text); return `saved ${text}`; },
  });
  const readFile = defineTool({
    name: 'read_file', description: 'Read a file', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false,
    describeActivity: () => ({ title: 'read' }), run: async ({ path }) => `contents of ${path}`,
  });
  return [saveNote, readFile];
}

describe('resuming a dry run', () => {
  it.each(['verify', 'rerun', 'ask'] as const)('never executes a mutating tool for real (resume: %s) and keeps its planned effects', async resume => {
    const base = createInMemoryStore();
    let now = 1_000;
    const process = crashableStore({ store: base });
    const counts: Counts = { ran: [], simulated: [] };
    const crash = (): void => { if (!process.isCrashed()) { process.crash(); throw new Error('simulated crash inside the simulation'); } };
    const aiA = runtimeOver({ store: process.store, provider: scriptedProvider(), now: () => now });
    await aiA.agent(definitionFor(noteTools({ resume, counts, crash }))).task(TASK).then(() => undefined, () => undefined);
    await aiA.close();
    now += LEASE_TTL_MS + 1;
    const aiB = runtimeOver({ store: base, provider: scriptedProvider(), now: () => now });
    const agent = aiB.agent(definitionFor(noteTools({ resume, counts })));
    await agent.ready;
    const resumed = agent.resume();
    expect(resumed).toBeDefined();
    const result = await resumed!;
    await aiB.close();
    expect(counts.ran).toEqual([]);
    expect(result.status).toBe('completed');
    expect(result.plannedEffects?.map(({ target }) => target)).toEqual(expect.arrayContaining(['first', 'second']));
  });
});
