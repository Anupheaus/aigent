import { describe, expect, it } from 'vitest';
import { computePrefixHash } from '../context/prefix-hash.js';
import type { TaskResult } from '../core/agent-types.js';
import type { ProviderRequest } from '../providers/provider-types.js';
import { CHECKPOINTS_COLLECTION, LEASES_COLLECTION } from './checkpoint-types.js';
import type { CallLedgerRecord } from './call-ledger.js';
import {
  CRASH_BOUNDARIES, crashableStore, createInMemoryStore, createWorld, definitionFor, INSTANCE_ID, LEASE_TTL_MS, runtimeOver, SCRIPT_ANSWER, scriptedProvider, worldTools,
} from './crash-injection.test-support.js';
import type { CrashableStore, CrashPlan } from './crash-injection.test-support.js';
import type { LeaseRecord } from './lease.js';

const TASK = { task: 'Save two notes and read a.txt', unattended: true };

function toolResults(request: ProviderRequest): string {
  return request.messages.flatMap(({ toolCallId }) => (toolCallId == null ? [] : [toolCallId])).join(',');
}

function prefixOf(request: ProviderRequest): string {
  return computePrefixHash(request.messages.filter(({ volatile }) => volatile !== true), request.tools);
}

async function controlRun() {
  const world = createWorld();
  const provider = scriptedProvider();
  const ai = runtimeOver({ store: createInMemoryStore(), provider, now: () => 1_000 });
  const result = await ai.agent(definitionFor(worldTools({ world }))).task(TASK);
  await ai.close();
  return { world, provider, result };
}

function doneCount(value: unknown): number {
  return (value as CallLedgerRecord).entries.filter(({ status }) => status === 'done').length;
}

/** Runs the task in one "process", crashing at the plan's boundary; then restarts on the same store and resumes. */
async function crashAndResume(plan: CrashPlan) {
  const base = createInMemoryStore();
  let now = 1_000;
  const world = createWorld();
  let occurrences = 0;
  let lastDone = 0;
  let process: CrashableStore | undefined;
  const hit = (boundary: CrashPlan['boundary']): boolean => {
    if (boundary !== plan.boundary || process?.isCrashed() === true) return false;
    occurrences += 1;
    if (occurrences !== plan.n) return false;
    process?.crash();
    return true;
  };
  process = crashableStore({
    store: base,
    beforeWrite: ({ collection, value }) => {
      if (collection === CHECKPOINTS_COLLECTION) hit('checkpoint-write');
      if (collection === 'calls' && doneCount(value) > lastDone) { lastDone = doneCount(value); hit('ledger-done'); }
    },
  });
  const crashed = process;
  const providerA = scriptedProvider({ onEvent: () => { if (crashed.isCrashed() || hit('mid-stream')) throw new Error('simulated crash mid-stream'); } });
  const toolsA = worldTools({ world, beforeRun: tool => {
    if (crashed.isCrashed()) throw new Error('simulated crash: the process is gone');
    if (hit(tool === 'read_file' ? 'mid-batch' : 'tool-dispatched')) throw new Error('simulated crash after the effect');
  } });
  const aiA = runtimeOver({ store: crashed.store, provider: providerA, now: () => now });
  const first = await aiA.agent(definitionFor(toolsA)).task(TASK).then(result => result, (error: unknown) => error);
  await aiA.close();
  if (!crashed.isCrashed()) return { didCrash: false, world, final: first as TaskResult, base };

  // Restart: a new runtime on the same store, after the dead owner's lease expired.
  now += LEASE_TTL_MS + 1;
  const providerB = scriptedProvider();
  const aiB = runtimeOver({ store: base, provider: providerB, now: () => now });
  const agent = aiB.agent(definitionFor(worldTools({ world })));
  await agent.ready;
  const resumed = agent.resume();
  const final = await (resumed ?? agent.task(TASK));
  await aiB.close();
  return { didCrash: true, didResume: resumed != null, world, final, base, providerB };
}

describe('crash injection: every boundary, resumed on a fresh runtime', async () => {
  const control = await controlRun();
  const matrix = CRASH_BOUNDARIES.flatMap(boundary => [1, 2, 3].map(n => ({ boundary, n })));

  it('the control run saves both notes once and answers', () => {
    expect(control.result).toMatchObject({ status: 'completed', answer: SCRIPT_ANSWER });
    expect(control.world.runs.get('save_note')).toBe(2);
  });

  it.each([{ boundary: 'checkpoint-write' as const, n: 2 }, { boundary: 'checkpoint-write' as const, n: 3 }, { boundary: 'ledger-done' as const, n: 2 }])('$boundary #$n resumes at a point of the control run with the identical prompt prefix', async plan => {
    const outcome = await crashAndResume(plan);
    const [firstResumed] = outcome.providerB?.requests ?? [];
    const same = control.provider.requests.find(request => toolResults(request) === toolResults(firstResumed!));
    expect(same).toBeDefined();
    expect(prefixOf(firstResumed!)).toBe(prefixOf(same!));
  });

  it.each(matrix)('$boundary #$n ends like the control run, each note saved exactly once', async plan => {
    const outcome = await crashAndResume(plan);
    expect(outcome.final).toMatchObject({ status: 'completed', answer: SCRIPT_ANSWER });
    // Exactly-once for the side effect: one effect per logical call, and the tool body never ran twice.
    expect([...outcome.world.effects.keys()].map(key => key.split(':').at(-1)).sort()).toEqual(['n1', 'n2']);
    expect(outcome.world.runs.get('save_note')).toBe(2);
    // read_file is read-only (rerun policy): at least once.
    expect(outcome.world.runs.get('read_file')).toBeGreaterThanOrEqual(1);
    if (!outcome.didCrash || outcome.providerB == null) return;
    // Where the resumed process stands at a point of the control run (no part of a response was lost), its first
    // request is byte-identical (prefix hash) to the control's there.
    const [firstResumed] = outcome.providerB.requests;
    const same = control.provider.requests.find(request => toolResults(request) === toolResults(firstResumed!));
    if (same != null) expect(prefixOf(firstResumed!)).toBe(prefixOf(same));
    // No duplicate checkpoint seqs, and the lease moved to the new owner with a higher fence.
    const seqs = (await outcome.base.list<{ seq: number; runId: string }>(CHECKPOINTS_COLLECTION)).map(({ value: { runId, seq } }) => `${runId}:${seq}`);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect((await outcome.base.get<LeaseRecord>(LEASES_COLLECTION, INSTANCE_ID))?.value.fence).toBe(2);
  });
});
