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
    const registry = buildAgentRegistry({ tools: [echo], now: () => 0 });
    expect(registry.names()).toEqual(['aigent_multi', 'echo']);
    expect(registry.list().some(({ jsonSchema }) => hasPrevious(jsonSchema))).toBe(false);
  });

  it('adds aigent_feedback and previous on every other tool when feedback is on', () => {
    const registry = buildAgentRegistry({ tools: [echo], now: () => 0, feedbackCollector: createFeedbackCollector() });
    expect(registry.names()).toEqual(['aigent_feedback', 'aigent_multi', 'echo']);
    expect(registry.list().map(({ name, jsonSchema }) => [name, hasPrevious(jsonSchema)])).toEqual([['aigent_feedback', false], ['aigent_multi', true], ['echo', true]]);
  });

  it('rejects a user tool that reuses a built-in name', () => {
    const impostor = defineTool({ ...echo, name: 'aigent_feedback', args: z.object({}).strict(), describeActivity: () => ({ title: 'x' }), run: async () => 1 });
    expect(() => buildAgentRegistry({ tools: [impostor], now: () => 0, feedbackCollector: createFeedbackCollector() })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });
});
