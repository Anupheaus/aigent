import { describe, expect, it } from 'vitest';
import { defineGuardrail } from '../guardrails/define-guardrail.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { RunRecord, TraceRecord } from '../telemetry/run-record.js';
import type { Skill } from '../learning/skills/skill-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeProvider, FakeTurn } from '../testing/fake-provider.js';
import { lookupTools, lookupTraces, storeTraces } from '../learning/skills/skills.test-support.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './aigent-types.js';
import type { IdGenerator } from './runtime-services.js';

function sequentialIds(): IdGenerator {
  let counter = 0;
  // Distinct from the fixture's run ids (`run_<n>`), which are already stored.
  return { next: prefix => `${prefix}-t${++counter}` };
}

const SKILL = 'skill_search_then_read_then_search_then_read';
const callSkill = (query: string): FakeTurn => toolTurn([{ id: 'k1', name: SKILL, args: { query } }]);

async function setup(params: { turns: FakeTurn[]; options?: Partial<AigentOptions>; traces?: ReturnType<typeof lookupTraces> }) {
  const { tools, calls } = lookupTools();
  const provider = createFakeProvider({ turns: params.turns });
  const store = createInMemoryStore();
  await storeTraces({ store, traces: params.traces ?? lookupTraces() });
  const ai = createAigent({ providers: [provider], store, ids: sequentialIds(), enableFeedback: false, ...params.options });
  const agent = ai.agent({ name: 'helper', model: 'fake:m', tools, skills: true });
  return { ai, agent, provider, store, calls };
}

function toolNames(provider: FakeProvider, index: number): string[] {
  return provider.requests[index]!.tools.map(({ name }) => name);
}

function systemOf(provider: FakeProvider, index: number): string {
  return provider.requests[index]!.messages[0]!.text!;
}

describe('createAigent skills', () => {
  it('distils a candidate that is never active without two approvals, and restores the baseline prompt when retired', async () => {
    const { ai, agent, provider, calls } = await setup({ turns: [textTurn('a'), textTurn('b'), callSkill('retry policy'), textTurn('done'), textTurn('c')] });
    const report = await ai.skills.distil('helper');
    expect(report.refused).toEqual([]);
    expect(report.created).toEqual([expect.objectContaining({ name: SKILL, status: 'candidate', version: 1, stats: expect.objectContaining({ replayPass: 1, supportingRuns: 4 }) })]);
    const id = report.created[0]!.id;
    await agent.task({ task: 'x' });
    const baselineSystem = systemOf(provider, 0);
    const baselineTools = provider.requests[0]!.tools;
    expect(toolNames(provider, 0)).not.toContain(SKILL);
    // First approval: a shadow hint, never a tool.
    expect((await ai.skills.approve(id)).status).toBe('shadow');
    await agent.task({ task: 'x' });
    expect(systemOf(provider, 1)).toContain(`- ${SKILL}: search -> read -> search -> read`);
    expect(toolNames(provider, 1)).not.toContain(SKILL);
    // Second approval: a tool, run through the dispatcher.
    expect((await ai.skills.approve(id)).status).toBe('active');
    const result = await agent.task({ task: 'where is the retry policy' });
    expect(toolNames(provider, 2)).toContain(SKILL);
    // The skill takes its place in the sorted tool list, so the prompt prefix stays byte-stable.
    expect(toolNames(provider, 2)).toEqual([...toolNames(provider, 2)].sort((left, right) => left.localeCompare(right)));
    expect(calls).toEqual(['search:retry policy', 'read:src/net/retry.ts', 'search:backoffMs', 'read:src/net/backoff.ts']);
    expect(result).toMatchObject({ status: 'completed', usage: { toolCalls: 4 } });
    expect((await ai.skills.retire(id)).status).toBe('retired');
    await agent.task({ task: 'x' });
    expect(systemOf(provider, 4)).toBe(baselineSystem);
    expect(provider.requests[4]!.tools).toEqual(baselineTools);
    expect((await ai.skills.list('helper')).map(({ status }) => status)).toEqual(['retired']);
    await ai.close();
  });

  it('traces each step as an inner call of the skill, with result leaves for later distillation', async () => {
    const { ai, agent, store } = await setup({ turns: [callSkill('cache key'), textTurn('done')] });
    const { created: [skill] } = await ai.skills.distil('helper');
    await ai.skills.approve(skill!.id);
    await ai.skills.approve(skill!.id);
    const result = await agent.task({ task: 'where is the cache key' });
    const { steps } = (await store.get<TraceRecord>('traces', result.runId))!.value;
    expect(steps.map(({ tool, parentCallId }) => [tool, parentCallId ?? null])).toEqual([[SKILL, null], ['search', 'k1'], ['read', 'k1'], ['search', 'k1'], ['read', 'k1']]);
    expect(steps[1]?.resultLeaves).toEqual([{ path: '/matches/0/line', value: 1 }, { path: '/matches/0/path', value: 'src/cache/key.ts' }]);
    await ai.close();
  });

  it('applies guardrails to every inner step', async () => {
    const blockSecondSearch = defineGuardrail({
      name: 'no-hash-search', stage: 'toolCall',
      check: value => ((value as { args?: { query?: string } }).args?.query === 'hashArgs' ? { action: 'block', code: 'no_hash', reason: 'not that one' } : { action: 'allow' }),
    });
    const { ai, agent, calls } = await setup({ turns: [callSkill('cache key'), textTurn('done')], options: { guardrails: { custom: [blockSecondSearch] } } });
    const { created: [skill] } = await ai.skills.distil('helper');
    await ai.skills.approve(skill!.id);
    await ai.skills.approve(skill!.id);
    const result = await agent.task({ task: 'where is the cache key' });
    expect(calls).toEqual(['search:cache key', 'read:src/cache/key.ts']);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'guardrail_blocked', details: expect.objectContaining({ code: 'no_hash', callId: 'step_3', parentCallId: 'k1' }) })]));
    await ai.close();
  });

  it('simulates side-effecting steps in a dry run, and asks a person for them otherwise (refused unattended)', async () => {
    // Runs whose second step wrote the file it found: distillable only with allowSideEffects.
    const traces = lookupTraces().map(trace => ({ ...trace, steps: trace.steps.slice(0, 2).map(step => (step.index === 1 ? { ...step, tool: 'write' } : step)) }))
      .map(trace => ({ ...trace, steps: trace.steps.map(step => (step.index === 1 ? { ...step, outcome: { success: true, answer: '', source: 'previous' as const } } : step)) }));
    const dry = await setup({ turns: [toolTurn([{ id: 'k1', name: 'skill_search_then_write', args: { query: 'retry policy' } }]), textTurn('planned'), toolTurn([{ id: 'k1', name: 'skill_search_then_write', args: { query: 'retry policy' } }]), textTurn('refused')], traces });
    expect((await dry.ai.skills.distil('helper')).refused).toEqual([expect.objectContaining({ reason: expect.stringContaining('side effects') })]);
    const { created: [skill] } = await dry.ai.skills.distil('helper', { allowSideEffects: true });
    await dry.ai.skills.approve(skill!.id);
    await dry.ai.skills.approve(skill!.id);
    const planned = await dry.agent.task({ task: 'write it', dryRun: true });
    expect(planned.plannedEffects).toEqual([expect.objectContaining({ tool: 'write', target: 'src/net/retry.ts' })]);
    expect(dry.calls).toEqual(['search:retry policy']);
    const unattended = await dry.agent.task({ task: 'write it', unattended: true });
    expect(dry.calls).toEqual(['search:retry policy', 'search:retry policy']);
    expect(unattended.errors).toEqual(expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({ callId: 'step_2', tool: 'write' }) })]));
    await dry.ai.close();
  });

  it('bumps the version when distilled again with changed steps, needs approval again, and rolls back', async () => {
    const { ai, store } = await setup({ turns: [] });
    const { created: [first] } = await ai.skills.distil('helper');
    await ai.skills.approve(first!.id);
    await ai.skills.approve(first!.id);
    // Newer runs searched another root: across all the runs the root now varies, so it becomes a parameter.
    const newer = lookupTraces().map(trace => ({
      ...trace, run: { ...trace.run, runId: `${trace.run.runId}_b`, responseId: `${trace.run.responseId}_b` },
      steps: trace.steps.map(step => (step.tool === 'search' ? { ...step, args: { ...(step.args as object), root: 'lib' } } : step)),
    }));
    await storeTraces({ store, traces: newer });
    const report = await ai.skills.distil('helper');
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([expect.objectContaining({ id: first!.id, version: 2, status: 'candidate' })]);
    const rolled = await ai.skills.rollback(first!.id, 1);
    expect(rolled).toMatchObject({ version: 1, status: 'active', previousVersions: [expect.objectContaining({ version: 2, status: 'candidate' })] });
    await expect(ai.skills.rollback(first!.id, 7)).rejects.toMatchObject({ code: 'invalid_input' });
    await ai.close();
  });

  it('never reuses a version number after a rollback: each number names one content', async () => {
    const { ai, store } = await setup({ turns: [] });
    const { created: [first] } = await ai.skills.distil('helper');
    const rerun = (suffix: string, change: (step: TraceRecord['steps'][number], runId: string) => TraceRecord['steps'][number]) => lookupTraces().map(trace => ({
      ...trace, run: { ...trace.run, runId: `${trace.run.runId}_${suffix}`, responseId: `${trace.run.responseId}_${suffix}` },
      steps: trace.steps.map(step => change(step, trace.run.runId)),
    }));
    await storeTraces({ store, traces: rerun('b', step => (step.tool === 'search' ? { ...step, args: { ...(step.args as object), root: 'lib' } } : step)) });
    await ai.skills.distil('helper');
    const second = (await ai.skills.get(first!.id))!;
    expect(second.version).toBe(2);
    await ai.skills.rollback(first!.id, 1);
    // Newer runs read other files at the end: the steps change again.
    await storeTraces({ store, traces: rerun('c', (step, runId) => (step.index === 3 ? { ...step, args: { path: `other/${runId}` } } : step)) });
    const report = await ai.skills.distil('helper');
    expect(report.updated).toEqual([expect.objectContaining({ id: first!.id, version: 3 })]);
    const third = (await ai.skills.get(first!.id))!;
    expect(third.steps).not.toEqual(second.steps);
    const versions = third.previousVersions.map(({ version }) => version);
    expect(new Set(versions).size).toBe(versions.length);
    expect((await ai.skills.rollback(first!.id, 2)).steps).toEqual(second.steps);
    await ai.close();
  });

  it('gives runs whose skills differ in content different effective agent versions, even under one version number', async () => {
    const { ai, agent, store } = await setup({ turns: [textTurn('a'), textTurn('b')] });
    const { created: [skill] } = await ai.skills.distil('helper');
    await ai.skills.approve(skill!.id);
    const before = await agent.task({ task: 'x' });
    // The same id, version and status with other steps (as a reused version number used to produce).
    const stored = (await store.get<Skill>('skills', skill!.id))!;
    await store.compareAndSet({ collection: 'skills', key: skill!.id, expectedVersion: stored.version, value: { ...stored.value, steps: stored.value.steps.slice(0, 2) } });
    const after = await agent.task({ task: 'x' });
    const versionOf = async (runId: string): Promise<string> => (await store.get<RunRecord>('runs', runId))!.value.agentVersion;
    expect(await versionOf(after.runId)).not.toBe(await versionOf(before.runId));
    await ai.close();
  });

  it('never churns an approved skill when distilled again without new runs, whatever other sequences use the same tools', async () => {
    const short = lookupTraces(2).map(trace => ({
      ...trace, run: { ...trace.run, runId: `${trace.run.runId}_short`, responseId: `${trace.run.responseId}_short` },
      steps: trace.steps.slice(2).map((step, index) => ({ ...step, index, ...(index === 1 ? { outcome: { success: true, answer: '', source: 'previous' as const } } : {}) })),
    }));
    const { ai } = await setup({ turns: [], traces: [...lookupTraces(), ...short] });
    const first = await ai.skills.distil('helper');
    expect(first.updated).toEqual([]);
    expect(first.created.every(({ version }) => version === 1)).toBe(true);
    const skill = first.created.find(({ name }) => name === SKILL)!;
    await ai.skills.approve(skill.id);
    await ai.skills.approve(skill.id);
    const again = await ai.skills.distil('helper');
    expect(again).toMatchObject({ created: [], updated: [] });
    expect(await ai.skills.get(skill.id)).toMatchObject({ version: 1, status: 'active' });
    await ai.close();
  });

  it('keeps skills per agent and lists them for inspection', async () => {
    const { ai } = await setup({ turns: [] });
    await expect(ai.skills.distil('nobody')).rejects.toMatchObject({ code: 'invalid_input' });
    await ai.skills.distil('helper');
    expect((await ai.skills.list('helper')).map(({ name }) => name)).toEqual([SKILL]);
    expect(await ai.skills.list('other')).toEqual([]);
    const [suggestion] = (await ai.report({ agentName: 'helper' })).toolSuggestions;
    expect(suggestion).toMatchObject({ name: 'search_then_read', skills: [{ agentName: 'helper', status: 'candidate', version: 1 }] });
    await ai.close();
  });
});
