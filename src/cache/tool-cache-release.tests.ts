import { describe, expect, it } from 'vitest';
import { setUpRunShaping, shapeWith } from '../core/run-shaping.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { ShapeResult } from '../tools/execute-tool-call.js';
import type { Tool } from '../tools/tool-types.js';
import { callTool, cacheHarness, countedTool, settlesWithin } from './tool-cache.test-support.js';

/** Far longer than any of these calls takes; a stranded single-flight never settles at all. */
const SETTLE_MS = 1_000;
const SLOW_VALIDITY_MS = 5_000;
const SHORT_TIMEOUT_MS = 50;

/** The real run shaper for a lossy-ok structured-data tool. */
function realShaper(tool: Tool): ShapeResult {
  const { shaping } = setUpRunShaping({ registry: createToolRegistry([tool]), settings: undefined, isFeedbackEnabled: false });
  if (shaping == null) throw new Error('expected shaping for a lossy-ok tool');
  return shapeWith(shaping);
}

function cyclicResult(): unknown {
  const node: Record<string, unknown> = { name: 'loop' };
  node.self = node;
  return node;
}

const lossyOk = { contentKind: 'structured-data', fidelity: 'lossy-ok' } as const;

describe('createToolCache: the single-flight is always released after a miss', () => {
  const unshapeable: [string, () => unknown][] = [
    ['a cyclic object', cyclicResult],
    ['a BigInt', () => ({ total: BigInt(12) })],
  ];

  it.each(unshapeable)('a lossy-ok result holding %s never strands identical later calls', async (_label, makeResult) => {
    const harness = cacheHarness();
    const { tool } = countedTool({ result: () => makeResult(), overrides: lossyOk });
    const shape = realShaper(tool);
    const first = await settlesWithin({ promise: callTool({ harness, tool, path: 'a', shape }), ms: SETTLE_MS });
    const second = await settlesWithin({ promise: callTool({ harness, tool, path: 'a', shape }), ms: SETTLE_MS });
    expect(first).not.toBe('timedOut');
    expect(second).not.toBe('timedOut');
  });

  const throwingSteps: [string, Partial<Tool>][] = [
    ['summarise', { summarise: () => { throw new Error('summarise broke'); } }],
    ['countItems', { countItems: () => { throw new Error('countItems broke'); } }],
    ['nestedFailures', { nestedFailures: () => { throw new Error('nestedFailures broke'); } }],
  ];

  it.each(throwingSteps)('a throwing %s after a miss resolves as a failure and releases the flight', async (step, override) => {
    const harness = cacheHarness();
    const counted = countedTool({});
    const tool: Tool = { ...counted.tool, ...override };
    const calls = [callTool({ harness, tool, path: 'a' }), callTool({ harness, tool, path: 'a' })];
    const settled = await Promise.all(calls.map(promise => settlesWithin({ promise, ms: SETTLE_MS })));
    expect(settled).not.toContain('timedOut');
    const [first] = settled;
    expect(first).toMatchObject({ envelope: { ok: false, error: { message: `${step} broke` } } });
  });

  it('a throwing shaper after a miss resolves as a failure and releases the flight', async () => {
    const harness = cacheHarness();
    const { tool } = countedTool({});
    const shape: ShapeResult = () => { throw new Error('shape broke'); };
    const calls = [callTool({ harness, tool, path: 'a', shape }), callTool({ harness, tool, path: 'a', shape })];
    const settled = await Promise.all(calls.map(promise => settlesWithin({ promise, ms: SETTLE_MS })));
    expect(settled).not.toContain('timedOut');
    expect(settled[0]).toMatchObject({ envelope: { ok: false, error: { message: 'shape broke' } } });
  });

  it('a throwing step on a hit resolves as a failure instead of rejecting', async () => {
    const harness = cacheHarness();
    const counted = countedTool({});
    await callTool({ harness, tool: counted.tool, path: 'a' });
    const broken: Tool = { ...counted.tool, summarise: () => { throw new Error('summarise broke'); } };
    const hit = await callTool({ harness, tool: broken, path: 'a' });
    expect(hit.envelope).toMatchObject({ ok: false, error: { message: 'summarise broke' } });
  });

  it('a slow validity token is bounded by the run signal', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({ overrides: { validity: () => new Promise(resolve => setTimeout(() => resolve('v'), SLOW_VALIDITY_MS)) } });
    const controller = new AbortController();
    const pending = callTool({ harness, tool, path: 'a', signal: controller.signal });
    controller.abort('stopped by the test');
    const settled = await settlesWithin({ promise: pending, ms: SETTLE_MS });
    expect(settled).toMatchObject({ envelope: { ok: false, error: { code: 'tool_aborted' } } });
    expect(runs()).toBe(0);
  });

  it('a validity token slower than the tool timeout lets the call run uncached', async () => {
    const harness = cacheHarness();
    const { tool, runs } = countedTool({ overrides: { timeoutMs: SHORT_TIMEOUT_MS, validity: () => new Promise(resolve => setTimeout(() => resolve('v'), SLOW_VALIDITY_MS)) } });
    const settled = await settlesWithin({ promise: callTool({ harness, tool, path: 'a' }), ms: SETTLE_MS });
    expect(settled).toMatchObject({ envelope: { ok: true, result: 'contents of a' } });
    expect(runs()).toBe(1);
  });
});
