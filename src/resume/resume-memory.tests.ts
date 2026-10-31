import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { storedMemories } from '../memory/memory.test-support.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import type { ToolCall } from '../providers/provider-types.js';
import { loadCallLedger } from './call-ledger.js';
import { crashableStore, createInMemoryStore, LEASE_TTL_MS, runtimeOver } from './crash-injection.test-support.js';

const INSTANCE = 'notes-1';
const TASK = { task: 'read a.txt', unattended: true };
const NOTE = { kind: 'fact', text: 'a.txt holds the config', tags: null, pinned: null };
const CRASH_DELAY_MS = 30;
const INNER_NOTE ={ kind: 'fact', text: 'inner notes are never saved', tags: null, pinned: null };

/** What the tool bodies saw, call by call. */
interface Seen {
  args: unknown[];
}

/** `read_file`, which crashes the process on its first run (after the round's checkpoint), and `lookup`. */
function tools(params: { seen: Seen; crash?(): void }): Tool[] {
  const { seen, crash } = params;
  let hasCrashed = crash == null;
  const read = defineTool({
    name: 'read_file', description: 'Read a file', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false,
    describeActivity: () => ({ title: 'read' }),
    run: async args => {
      seen.args.push(args);
      if (!hasCrashed) {
        hasCrashed = true;
        // Long enough for the round's checkpoint (the response with its raw calls) and the queued notes to be written.
        await new Promise(resolve => setTimeout(resolve, CRASH_DELAY_MS));
        crash?.();
        throw new Error('simulated crash');
      }
      return 'contents';
    },
  });
  const lookup = defineTool({
    name: 'lookup', description: 'Look a key up', args: z.object({ key: z.string() }).strict(), deterministic: false, cache: false,
    describeActivity: () => ({ title: 'lookup' }), run: async args => { seen.args.push(args); return 'value'; },
  });
  return [read, lookup];
}

/** Runs `call` in a first process that crashes inside `read_file`, then resumes the run in a second one. */
async function crashThenResume(call: ToolCall) {
  const base = createInMemoryStore();
  const process = crashableStore({ store: base });
  let now = 1_000;
  const seen: Seen = { args: [] };
  const definition = (toolList: Tool[]) => ({ name: 'notes', model: 'fake:m', tools: toolList, instanceId: INSTANCE, todo: false });
  const aiA = runtimeOver({ store: process.store, provider: createFakeProvider({ turns: [toolTurn([call]), textTurn('done')] }), now: () => now, options: { memory: true } });
  await aiA.agent(definition(tools({ seen, crash: () => process.crash() }))).task(TASK).then(() => undefined, () => undefined);
  await aiA.close().catch(() => undefined);
  now += LEASE_TTL_MS + 1;
  const provider: FakeProvider = createFakeProvider({ turns: [textTurn('done')] });
  const aiB = runtimeOver({ store: base, provider, now: () => now, options: { memory: true } });
  const agent = aiB.agent(definition(tools({ seen })));
  await agent.ready;
  const run = agent.resume();
  const warnings: string[] = [];
  for await (const event of run ?? []) if (event.type === 'warning') warnings.push(event.message);
  const result = await run;
  await aiB.close();
  const resultText = provider.requests[0]?.messages.find(({ toolCallId }) => toolCallId === call.id)?.text ?? '';
  return { base: base as Store, result, seen, resultText, warnings };
}

describe('resuming a run whose interrupted call carried memory', () => {
  it('re-runs the call without its memory field, and keeps it out of the ledger', async () => {
    const { base, result, seen, resultText } = await crashThenResume({ id: 'r1', name: 'read_file', args: { path: 'a.txt', memory: [NOTE] } });
    expect(result?.status).toBe('completed');
    expect(seen.args).toEqual([{ path: 'a.txt' }, { path: 'a.txt' }]);
    expect(resultText).toContain('contents');
    expect(resultText).not.toContain('invalid_arguments');
    const ledger = await loadCallLedger({ store: base, runId: result?.runId ?? '' });
    expect(ledger.map(({ args }) => args)).toEqual([{ path: 'a.txt' }]);
    expect(JSON.stringify(ledger)).not.toContain(NOTE.text);
  });

  it('keeps the note the interrupted process saved, once: the re-run is not a repeat that raises its confidence', async () => {
    const { base, result } = await crashThenResume({ id: 'r1', name: 'read_file', args: { path: 'a.txt', memory: [NOTE] } });
    const entries = await storedMemories(base);
    expect(entries.map(({ text, confidence, source }) => ({ text, confidence, source }))).toEqual([
      { text: NOTE.text, confidence: 0.6, source: { runId: result?.runId, callId: 'r1', origin: 'tool-call' } },
    ]);
  });

  it('takes memory out of an interrupted aigent_multi call and its inner calls', async () => {
    const multi = {
      id: 'm1', name: 'aigent_multi',
      args: { memory: [NOTE], calls: [{ id: 'a', tool: 'lookup', args: { key: 'k', memory: [INNER_NOTE] } }, { id: 'b', tool: 'read_file', args: { path: 'a.txt', memory: [INNER_NOTE] } }] },
    };
    const { base, result, seen, resultText } = await crashThenResume(multi);
    expect(result?.status).toBe('completed');
    expect(seen.args).toEqual([{ key: 'k' }, { path: 'a.txt' }, { path: 'a.txt' }]);
    expect(JSON.parse(resultText)).toMatchObject({ ok: true, result: [{ id: 'a', ok: true }, { id: 'b', ok: true, result: 'contents' }] });
    expect((await storedMemories(base)).map(({ text }) => text)).toEqual([NOTE.text]);
  });
});
