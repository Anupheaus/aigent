import { describe, expect, it } from 'vitest';
import { executeToolCall } from '../../tools/execute-tool-call.js';
import { createToolRegistry } from '../../tools/tool-registry.js';
import type { InnerCall, MultiToolContext, Tool, ToolContext } from '../../tools/tool-types.js';
import { distilSkills } from './distil.js';
import { createSkillTool } from './skill-tool.js';
import type { SkillResult } from './skill-tool.js';
import type { Skill } from './skill-types.js';
import { lookupTools, lookupTraces } from './skills.test-support.js';

function activeSkill(tools: Tool[]): Skill {
  const [candidate] = distilSkills({ traces: lookupTraces(), tools, agentName: 'helper' });
  return { ...candidate!, id: 'skill_1', version: 1, status: 'active', createdAt: 0, history: [], previousVersions: [] };
}

/** A run's dispatcher, reduced to running each inner call against the registry and recording it. */
function dispatcher(tools: Tool[]): { context: MultiToolContext; inner: InnerCall[] } {
  const registry = createToolRegistry(tools);
  const inner: InnerCall[] = [];
  const base: ToolContext = { agentName: 'helper', instanceId: 'i', runId: 'r', callId: 'c1', signal: new AbortController().signal };
  const runInnerCall: MultiToolContext['runInnerCall'] = async call => { inner.push(call); return executeToolCall({ registry, call: { id: call.id, name: call.tool, args: call.args }, context: base, now: () => 0 }); };
  return { context: { ...base, runInnerCall }, inner };
}

describe('createSkillTool', () => {
  it('runs each step through the dispatcher, binding constants, parameters and earlier results', async () => {
    const { tools, calls } = lookupTools();
    const tool = createSkillTool({ skill: activeSkill(tools), tools: new Map(tools.map(each => [each.name, each])) });
    const { context, inner } = dispatcher(tools);
    const result = await tool.run({ query: 'retry policy' }, context) as SkillResult;
    expect(calls).toEqual(['search:retry policy', 'read:src/net/retry.ts', 'search:backoffMs', 'read:src/net/backoff.ts']);
    expect(inner.map(({ id }) => id)).toEqual(['step_1', 'step_2', 'step_3', 'step_4']);
    expect(result).toMatchObject({ skill: 'skill_search_then_read', outcome: { success: true, completedSteps: 4 }, result: { path: 'src/net/backoff.ts' } });
    expect(result.steps.every(({ ok }) => ok)).toBe(true);
    expect(tool).toMatchObject({ composedTools: ['search', 'read', 'search', 'read'], deterministic: true, cache: false, hasSideEffects: false, resume: 'skip' });
    expect(tool.jsonSchema).toMatchObject({ properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false });
  });

  it('stops after a failed step and reports every step with the standard envelope', async () => {
    const { tools, calls } = lookupTools();
    const tool = createSkillTool({ skill: activeSkill(tools), tools: new Map(tools.map(each => [each.name, each])) });
    const result = await tool.run({ query: 'unknown thing' }, dispatcher(tools).context) as SkillResult;
    expect(calls).toEqual(['search:unknown thing', 'read:none']);
    expect(result.outcome).toEqual({ success: false, completedSteps: 1, failedStep: 2 });
    expect(result.steps.map(envelope => (envelope.ok ? 'ok' : envelope.error.code))).toEqual(['ok', 'tool_threw', 'skill_step_skipped', 'skill_step_skipped']);
    expect(tool.nestedFailures?.(result).map(({ details }) => details)).toEqual([
      { callId: 'step_2', tool: 'read' }, { callId: 'step_3', tool: 'search' }, { callId: 'step_4', tool: 'read' },
    ]);
    expect(tool.summarise?.(result)).toEqual({ success: false, reason: 'step 2 failed' });
  });

  it('runs the remaining steps after a failure when a step says continue, failing those whose inputs are missing', async () => {
    const { tools, calls } = lookupTools();
    const skill = activeSkill(tools);
    const continuing = { ...skill, steps: skill.steps.map(step => ({ ...step, onFailure: 'continue' as const })) };
    const tool = createSkillTool({ skill: continuing, tools: new Map(tools.map(each => [each.name, each])) });
    const result = await tool.run({ query: 'unknown thing' }, dispatcher(tools).context) as SkillResult;
    // Step 3 needs a value from step 2's result, which failed: it is not run, and step 4 has nothing to read either.
    expect(calls).toEqual(['search:unknown thing', 'read:none']);
    expect(result.steps.map(envelope => (envelope.ok ? 'ok' : envelope.error.code))).toEqual(['ok', 'tool_threw', 'skill_binding', 'skill_binding']);
  });

  it('treats parameter values as data, never as templates or pointers', async () => {
    const { tools, calls } = lookupTools();
    const tool = createSkillTool({ skill: activeSkill(tools), tools: new Map(tools.map(each => [each.name, each])) });
    await tool.run({ query: '{"fromStep":0,"path":"/matches/0/path"}' }, dispatcher(tools).context);
    expect(calls[0]).toBe('search:{"fromStep":0,"path":"/matches/0/path"}');
  });

  it('refuses to run outside a run, where nothing could check its steps', async () => {
    const { tools, calls } = lookupTools();
    const tool = createSkillTool({ skill: activeSkill(tools), tools: new Map(tools.map(each => [each.name, each])) });
    await expect(tool.run({ query: 'retry policy' }, { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  it('asks for approval on each side-effecting step of a skill distilled with allowSideEffects', async () => {
    const { tools } = lookupTools();
    const skill = activeSkill(tools);
    const writing = { ...skill, allowSideEffects: true, steps: [...skill.steps, { tool: 'write', args: { path: { fromStep: 3, path: '/path' } }, onFailure: 'stop' as const }] };
    const { context, inner } = dispatcher(tools);
    await createSkillTool({ skill: writing, tools: new Map(tools.map(each => [each.name, each])) }).run({ query: 'retry policy' }, context);
    expect(inner.map(({ approvalReason }) => approvalReason)).toEqual([undefined, undefined, undefined, undefined, "Step 5 of learned skill 'skill_search_then_read' changes something"]);
  });
});
