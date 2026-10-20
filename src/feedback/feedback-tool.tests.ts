import { describe, expect, it } from 'vitest';
import { executeToolCall } from '../tools/execute-tool-call.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { createFeedbackCollector } from './feedback-collector.js';
import { createFeedbackTool, FEEDBACK_TOOL_NAME } from './feedback-tool.js';

const CONTEXT = { agentName: 'a', instanceId: 'i', runId: 'run_1', signal: new AbortController().signal };
const now = (): number => 0;

function setup() {
  const collector = createFeedbackCollector();
  const tool = createFeedbackTool({ collector });
  return { collector, tool, registry: createToolRegistry([tool]) };
}

describe('aigent_feedback', () => {
  it('is a strict, non-deterministic, uncached, side-effect-free tool with an activity renderer', () => {
    const { tool } = setup();
    expect(tool).toMatchObject({ name: FEEDBACK_TOOL_NAME, strict: true, deterministic: false, cache: false, hasSideEffects: false });
    expect(tool.jsonSchema).toMatchObject({ required: ['entries'], properties: { entries: { type: 'array', minItems: 1, maxItems: 10 } } });
    const view = tool.describeActivity({ entries: [{ kind: 'hard', text: 'x' }, { kind: 'easy', text: 'y' }] }, Promise.resolve({ success: true, reason: 'ok' }));
    expect(view).toEqual({ title: 'Recording 2 feedback entries', detail: 'hard, easy' });
  });

  it('collects every entry against its run and call, in order', async () => {
    const { collector, registry } = setup();
    const entries = [{ kind: 'hard', text: 'Finding the config took 4 searches', relatedTool: 'search' }, { kind: 'simplify', text: 'A find_config tool', relatedTool: null }];
    const executed = await executeToolCall({ registry, call: { id: 'f1', name: FEEDBACK_TOOL_NAME, args: { entries } }, context: CONTEXT, now });
    expect(executed.envelope).toEqual({ id: 'f1', tool: FEEDBACK_TOOL_NAME, ok: true, result: { recorded: 2 } });
    expect(collector.take('run_1')).toEqual([
      { runId: 'run_1', callId: 'f1', index: 0, entry: { kind: 'hard', text: 'Finding the config took 4 searches', relatedTool: 'search' } },
      { runId: 'run_1', callId: 'f1', index: 1, entry: { kind: 'simplify', text: 'A find_config tool' } },
    ]);
    expect(collector.take('run_1')).toEqual([]);
  });

  it.each([
    [{ entries: [] }, 'entries'],
    [{ entries: Array.from({ length: 11 }, () => ({ kind: 'easy', text: 'x' })) }, 'entries'],
    [{ entries: [{ kind: 'great', text: 'x' }] }, 'entries.0.kind'],
    [{ entries: [{ kind: 'easy', text: '' }] }, 'entries.0.text'],
    [{ entries: [{ kind: 'easy', text: 'x'.repeat(501) }] }, 'entries.0.text'],
    [{ entries: [{ kind: 'easy', text: 'x', relatedTool: 'y'.repeat(65) }] }, 'entries.0.relatedTool'],
    [{ entries: [{ kind: 'easy', text: 'x', extra: 1 }] }, 'entries.0'],
  ])('rejects %j with a validation error at %s and records nothing', async (args, path) => {
    const { collector, registry } = setup();
    const executed = await executeToolCall({ registry, call: { id: 'f1', name: FEEDBACK_TOOL_NAME, args }, context: CONTEXT, now });
    expect(executed.envelope).toMatchObject({ ok: false, error: { category: 'validation', fieldErrors: [expect.objectContaining({ path })] } });
    expect(collector.take('run_1')).toEqual([]);
  });

  it('keeps runs apart', async () => {
    const { collector, registry } = setup();
    const call = (runId: string) => executeToolCall({ registry, call: { id: 'f', name: FEEDBACK_TOOL_NAME, args: { entries: [{ kind: 'easy', text: runId }] } }, context: { ...CONTEXT, runId }, now });
    await Promise.all([call('a'), call('b'), call('a')]);
    expect(collector.take('a').map(({ entry }) => entry.text)).toEqual(['a', 'a']);
    expect(collector.take('b').map(({ entry }) => entry.text)).toEqual(['b']);
  });
});
