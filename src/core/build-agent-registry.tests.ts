import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFeedbackCollector } from '../feedback/feedback-collector.js';
import { defineTool } from '../tools/define-tool.js';
import { buildAgentRegistry } from './build-agent-registry.js';

const echo = defineTool({ name: 'echo', description: 'e', args: z.object({ text: z.string() }).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async args => args.text });

function hasPrevious(schema: Record<string, unknown>): boolean {
  return 'previous' in ((schema.properties ?? {}) as object);
}

describe('buildAgentRegistry', () => {
  it('adds only aigent_multi when feedback is off', () => {
    const registry = buildAgentRegistry({ agentName: 'helper', tools: [echo], now: () => 0 });
    expect(registry.names()).toEqual(['aigent_multi', 'echo']);
    expect(registry.list().some(({ jsonSchema }) => hasPrevious(jsonSchema))).toBe(false);
  });

  it('adds aigent_feedback and previous on every other tool when feedback is on', () => {
    const registry = buildAgentRegistry({ agentName: 'helper', tools: [echo], now: () => 0, feedbackCollector: createFeedbackCollector() });
    expect(registry.names()).toEqual(['aigent_feedback', 'aigent_multi', 'echo']);
    expect(registry.list().map(({ name, jsonSchema }) => [name, hasPrevious(jsonSchema)])).toEqual([['aigent_feedback', false], ['aigent_multi', true], ['echo', true]]);
  });

  it('rejects a user tool that reuses a built-in name', () => {
    const impostor = defineTool({ ...echo, name: 'aigent_feedback', args: z.object({}).strict(), describeActivity: () => ({ title: 'x' }), run: async () => 1 });
    expect(() => buildAgentRegistry({ agentName: 'helper', tools: [impostor], now: () => 0, feedbackCollector: createFeedbackCollector() })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });

  it('rejects, with feedback on, a tool that declares its own previous argument, naming the agent and tool', () => {
    const note = defineTool({ ...echo, name: 'note', args: z.object({ previous: z.string() }).strict(), describeActivity: () => ({ title: 'n' }), run: async args => args.previous });
    expect(() => buildAgentRegistry({ agentName: 'helper', tools: [note], now: () => 0, feedbackCollector: createFeedbackCollector() })).toThrow(expect.objectContaining({
      code: 'invalid_definition',
      message: expect.stringMatching(/Tool 'note' of agent 'helper' declares an argument named 'previous'.*reserved.*enableFeedback/),
      details: { agentName: 'helper', tool: 'note', argument: 'previous' },
    }));
  });

  it("keeps a tool's own previous argument untouched when feedback is off", () => {
    const note = defineTool({ ...echo, name: 'note', args: z.object({ previous: z.string() }).strict(), describeActivity: () => ({ title: 'n' }), run: async args => args.previous });
    const registry = buildAgentRegistry({ agentName: 'helper', tools: [note], now: () => 0 });
    expect(registry.get('note')?.jsonSchema).toEqual(note.jsonSchema);
  });

  it('adds memory to every tool but aigent_feedback when memory is on, and none when it is off', () => {
    const hasMemory = (schema: Record<string, unknown>): boolean => 'memory' in ((schema.properties ?? {}) as object);
    const on = buildAgentRegistry({ agentName: 'helper', tools: [echo], now: () => 0, feedbackCollector: createFeedbackCollector(), memory: { maxPerCall: 3 } });
    expect(on.list().map(({ name, jsonSchema }) => [name, hasMemory(jsonSchema)])).toEqual([['aigent_feedback', false], ['aigent_multi', true], ['echo', true]]);
    const off = buildAgentRegistry({ agentName: 'helper', tools: [echo], now: () => 0 });
    expect(off.list().some(({ jsonSchema }) => hasMemory(jsonSchema))).toBe(false);
  });

  it('rejects, with memory on, a tool that declares its own memory argument', () => {
    const note = defineTool({ ...echo, name: 'note', args: z.object({ memory: z.string() }).strict(), describeActivity: () => ({ title: 'n' }), run: async args => args.memory });
    expect(() => buildAgentRegistry({ agentName: 'helper', tools: [note], now: () => 0, memory: { maxPerCall: 3 } })).toThrow(expect.objectContaining({
      code: 'invalid_definition', message: expect.stringMatching(/Tool 'note' of agent 'helper' declares an argument named 'memory'.*reserved.*memory: false/),
    }));
    expect(() => buildAgentRegistry({ agentName: 'helper', tools: [note], now: () => 0 })).not.toThrow();
  });
});
