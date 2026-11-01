import { describe, expect, it } from 'vitest';
import type { RunTrace } from '../../telemetry/run-record.js';
import { distilSkills, skillNameFor } from './distil.js';
import type { SkillRefusal } from './skill-types.js';
import { lookupTools, lookupTraces } from './skills.test-support.js';
import { validateSkill } from './validate-skill.js';

const { tools } = lookupTools();

function distil(traces: RunTrace[], extra: { allowSideEffects?: boolean; minSupport?: number } = {}): { candidates: ReturnType<typeof distilSkills>; refused: SkillRefusal[] } {
  const refused: SkillRefusal[] = [];
  const candidates = distilSkills({ traces, tools, agentName: 'helper', ...extra, onRefused: refusal => refused.push(refusal) });
  return { candidates, refused };
}

describe('distilSkills', () => {
  it('distils search -> read -> search -> read with constant, parameter and fromStep bindings', () => {
    const { candidates, refused } = distil(lookupTraces());
    expect(refused).toEqual([]);
    expect(candidates).toHaveLength(1);
    const [skill] = candidates;
    // Written out by hand from the fixture: the root never varies, the first query does, and every later
    // argument is a value an earlier step returned.
    expect(skill).toMatchObject({
      name: 'skill_search_then_read_then_search_then_read',
      agentName: 'helper',
      argsSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      steps: [
        { tool: 'search', args: { query: { param: 'query' }, root: { const: 'src' } }, onFailure: 'stop' },
        { tool: 'read', args: { path: { fromStep: 0, path: '/matches/0/path' } }, onFailure: 'stop' },
        { tool: 'search', args: { query: { fromStep: 1, path: '/mentions' }, root: { const: 'src' } }, onFailure: 'stop' },
        { tool: 'read', args: { path: { fromStep: 2, path: '/matches/0/path' } }, onFailure: 'stop' },
      ],
      stats: { supportingRuns: 4 },
      supportingRunIds: ['run_1', 'run_2', 'run_3', 'run_4'],
    });
    expect(skill?.examples[0]).toEqual({ args: { query: 'login handler' }, summary: 'as in run run_1' });
  });

  it('names each skill after its full ordered tool sequence, so different sequences never share a name', () => {
    // Two more runs that only searched and read: a sequence of the same tools, but a different one.
    const short = lookupTraces(2).map(trace => ({
      ...trace, run: { ...trace.run, runId: `${trace.run.runId}_short`, responseId: `${trace.run.responseId}_short` },
      steps: trace.steps.slice(2).map((step, index) => ({ ...step, index, ...(index === 1 ? { outcome: { success: true, answer: '', source: 'previous' as const } } : {}) })),
    }));
    const { candidates } = distil([...lookupTraces(), ...short]);
    const names = candidates.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(candidates.find(({ steps }) => steps.length === 4)?.name).toBe('skill_search_then_read_then_search_then_read');
    expect(candidates.find(({ steps }) => steps.length === 2)?.name).toBe('skill_search_then_read');
  });

  it('keeps names within the tool name limit and still distinct when two long sequences share a prefix', () => {
    const long = ['search_everything', 'read_the_file', 'search_everything', 'read_the_file', 'search_everything'];
    const first = skillNameFor([...long, 'read_the_file']);
    const second = skillNameFor([...long, 'write_the_file']);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^skill_search_everything_then_read_the_file/);
    expect(skillNameFor([...long, 'read_the_file'])).toBe(first);
  });

  it('refuses low support', () => {
    expect(distil(lookupTraces(2)).candidates).toEqual([]);
    expect(distil(lookupTraces(1), { minSupport: 1 }).candidates).toEqual([]);
  });

  it('never learns from runs rated incorrect or not completed', () => {
    const traces = lookupTraces().map((trace, index) => (index === 0 ? { ...trace, run: { ...trace.run, userVerdict: 'incorrect' as const } } : index === 1 ? { ...trace, run: { ...trace.run, status: 'failed' as const } } : trace));
    expect(distil(traces).candidates).toEqual([]);
  });

  it('refuses sequences with side effects unless allowed, and then marks the skill', () => {
    const traces = lookupTraces().map(trace => ({ ...trace, steps: trace.steps.map(step => (step.index === 1 ? { ...step, tool: 'write' } : step)) }));
    const blocked = distil(traces);
    expect(blocked.candidates).toEqual([]);
    expect(blocked.refused).toEqual([expect.objectContaining({ reason: expect.stringContaining('has side effects (write)') })]);
    expect(distil(traces, { allowSideEffects: true }).candidates[0]).toMatchObject({ allowSideEffects: true });
  });

  it('refuses steps without captured arguments, and arguments that vary but are not scalars', () => {
    const uncaptured = lookupTraces().map(trace => ({ ...trace, steps: trace.steps.map(({ args: _args, ...step }) => step) }));
    expect(distil(uncaptured).refused).toEqual([expect.objectContaining({ reason: expect.stringContaining('no captured arguments') })]);
    const objects = lookupTraces().map((trace, run) => ({ ...trace, steps: trace.steps.map(step => (step.index === 0 ? { ...step, args: { query: { text: `q${run}` }, root: 'src' } } : step)) }));
    expect(distil(objects).refused).toEqual([expect.objectContaining({ reason: expect.stringContaining('not a scalar') })]);
  });
});

describe('validateSkill (replay gate)', () => {
  const traces = lookupTraces();
  const [candidate] = distil(traces).candidates;

  it('reproduces every supporting trace', () => {
    expect(validateSkill(candidate!, traces)).toEqual({ replayPass: 1, failures: [] });
  });

  it('fails a tampered trace', () => {
    // Run 3's second read went somewhere its search never returned: the binding cannot reproduce it.
    const tampered = traces.map(trace => (trace.run.runId === 'run_3' ? { ...trace, steps: trace.steps.map(step => (step.index === 3 ? { ...step, args: { path: 'src/elsewhere.ts' } } : step)) } : trace));
    expect(validateSkill(candidate!, tampered)).toEqual({ replayPass: 0.75, failures: [{ runId: 'run_3', reason: 'step 4 (read) was replayed with arguments the run never used' }] });
  });

  it('fails a binding to a parameter the schema does not declare', () => {
    const broken = { ...candidate!, steps: candidate!.steps.map((step, index) => (index === 0 ? { ...step, args: { ...step.args, query: { param: 'ghost' } } } : step)) };
    expect(validateSkill(broken, traces).replayPass).toBe(0);
    expect(validateSkill(broken, traces).failures[0]?.reason).toContain('ghost');
  });

  it('fails when a supporting run is missing', () => {
    expect(validateSkill(candidate!, traces.slice(1)).failures).toEqual([{ runId: 'run_1', reason: 'the supporting run is not stored' }]);
  });
});
