import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from '../../../src/tools/packs/fs/index.js';
import { parseArgs } from '../cli-args.js';
import { createModelSolver, modelSolverFromEnv } from '../model-solver.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../src/testing/index.js';
import { readSpecs } from '../tasks/spec-files.js';
import { buildReport, quantile, reportMarkdown } from './report.js';
import { repoTools } from './repo-tools.js';
import { benchRepo } from './repo-cache.js';
import { runSuite } from './suite.js';
import { runTask } from './run-task.js';
import { recordTools } from './tool-recorder.js';
import { withFailingReads, withMutatingReads } from './trap-access.js';
import { scriptedSolver } from '../solvers/registry.js';

const text = async (read: Promise<Uint8Array>): Promise<string> => new TextDecoder().decode(await read);

describe('trap access wrappers', () => {
  const base = createMemoryFsAccess({ platform: 'posix', files: { '/r/a.ts': 'a\n' } });

  it('fails the first read of a path, then recovers', async () => {
    const access = withFailingReads({ access: base, path: '/r/a.ts' });
    await expect(access.readFile('/r/a.ts')).rejects.toMatchObject({ code: 'EIO' });
    expect(await text(access.readFile('/r/a.ts'))).toBe('a\n');
  });

  it('changes a file on every read, keeping its identity', async () => {
    const access = withMutatingReads({ access: base, path: '/r/a.ts' });
    expect(await text(access.readFile('/r/a.ts'))).toBe('// regenerated, revision 1\na\n');
    const handle = await access.open('/r/a.ts');
    expect(new TextDecoder().decode(await handle.read({ offset: 0, length: 100 }))).toContain('revision 2');
    expect((await handle.stat?.())?.fileId).toBe((await base.stat('/r/a.ts')).fileId);
  });
});

describe('harness', () => {
  it('records tool calls, items and result sizes without changing results', async () => {
    const repo = await benchRepo({ seed: 1, size: 'small' });
    const recorder = recordTools(repoTools({ repo }));
    expect(recorder.tools.map(({ name }) => name).sort()).toEqual(['fs_list', 'fs_read', 'fs_search']);
    const spec = (await readSpecs()).find(({ id }) => id === 'string-usage/precise/small/s1');
    expect(spec).toBeDefined();
    if (spec == null) return;
    const row = await runTask({ spec, solver: scriptedSolver('reference') });
    expect(row).toMatchObject({ correct: true, tier: 'target', toolCalls: 1, tools: { fs_search: { calls: 1, items: 1 } } });
  });

  it('produces the same report for the same runs (apart from wall time)', async () => {
    const specs = (await readSpecs()).filter(({ id }) => id.startsWith('find-named-file/precise') || id.startsWith('endpoints/precise'));
    const report = async () => {
      const built = buildReport({ label: 'r', tier: 'scripted', runs: await runSuite({ specs, solvers: [scriptedSolver('reference'), scriptedSolver('naive')], repeat: 2 }), specs: specs.length });
      return JSON.stringify({ ...built, rows: built.rows.map(({ ms: _ms, ...row }) => row), variance: built.variance.map(({ ms: _ms, ...entry }) => entry) });
    };
    const first = await report();
    expect(await report()).toBe(first);
    expect(JSON.parse(first)).toMatchObject({ repeat: 2, specs: 2, aggregates: [{ solver: 'reference', passRate: 1, targetRate: 1 }, { solver: 'naive', passRate: 1, targetRate: 0 }] });
  });

  it('computes nearest-rank quantiles and renders markdown', () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(quantile([], 0.5)).toBe(0);
    expect(reportMarkdown(buildReport({ label: 'round-x', tier: 'scripted', runs: [], specs: 0 }))).toContain('# round-x');
  });
});

describe('model solver and CLI', () => {
  it('runs a model through createAigent (a fake provider here: the model tier is never run in tests)', async () => {
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'c1', name: 'fs_search', args: { items: [{ path: '.', pattern: 'x', kind: 'name' }] } }]), textTurn('{"none": true}')] });
    const repo = await benchRepo({ seed: 1, size: 'small' });
    const outcome = await createModelSolver({ provider, model: 'fake:m' }).solve({ prompt: 'where is `x.ts`?', scope: ['.'], tools: repoTools({ repo }) });
    expect(outcome).toMatchObject({ answer: { none: true }, status: 'completed', usage: { turns: 2, toolCalls: 1 } });
    expect(provider.requests[0]?.messages[0]?.text).toContain('JSON only');
  });

  it('selects the model from BENCH_MODEL and refuses missing keys', () => {
    expect(() => modelSolverFromEnv({})).toThrow(/BENCH_MODEL/);
    expect(() => modelSolverFromEnv({ BENCH_MODEL: 'anthropic:claude' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => modelSolverFromEnv({ BENCH_MODEL: 'mystery:m' })).toThrow(/not one of/);
    expect(modelSolverFromEnv({ BENCH_MODEL: 'ollama:qwen2.5-coder' }).id).toBe('model:ollama:qwen2.5-coder');
  });

  it('parses the CLI flags', () => {
    expect(parseArgs([])).toEqual({ tier: 'scripted', repeat: 1, heldOut: false, buildSpecs: false, policies: ['naive', 'reference'], tools: 'round0' });
    expect(parseArgs(['--tier', 'model', '--seed', '1,2', '--repeat', '3', '--held-out', '--label', 'round-0', '--fresh-seeds', '7'])).toMatchObject({ tier: 'model', seeds: [1, 2], repeat: 3, heldOut: true, label: 'round-0', freshSeeds: [7] });
    expect(() => parseArgs(['--repeat', '0'])).toThrow(/at least 1/);
    expect(() => parseArgs(['--seed'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
  });
});
