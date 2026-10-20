import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool.js';
import { createToolRegistry } from './tool-registry.js';

function makeTool(name: string) {
  return defineTool({ name, description: name, args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: name }), run: async () => name });
}

describe('createToolRegistry', () => {
  it('looks tools up and lists specs sorted by name for a stable prompt prefix', () => {
    const registry = createToolRegistry([makeTool('b_tool'), makeTool('a_tool')]);
    expect(registry.get('a_tool')?.name).toBe('a_tool');
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.specs().map(spec => spec.name)).toEqual(['a_tool', 'b_tool']);
    expect(registry.specs()[0]).toMatchObject({ description: 'a_tool', parameters: { type: 'object' } });
  });

  it('rejects duplicate names', () => {
    expect(() => createToolRegistry([makeTool('x'), makeTool('x')])).toThrow(/duplicate.*'x'/i);
  });
});
