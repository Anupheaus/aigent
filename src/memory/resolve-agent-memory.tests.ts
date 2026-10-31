import { describe, expect, it } from 'vitest';
import { resolveAgentMemory } from './resolve-agent-memory.js';

const BASE = { agentName: 'helper', hasStore: true, captureContent: true };

describe('resolveAgentMemory', () => {
  it('is off by default, even with a store', () => {
    expect(resolveAgentMemory({ ...BASE })).toBeUndefined();
  });

  it('follows the runtime default unless the agent sets its own', () => {
    expect(resolveAgentMemory({ ...BASE, runtime: { maxPerCall: 2 } })?.maxPerCall).toBe(2);
    expect(resolveAgentMemory({ ...BASE, runtime: true, agent: false })).toBeUndefined();
    expect(resolveAgentMemory({ ...BASE, agent: { scope: 'session' } })?.scope).toBe('session');
    // The agent's options replace the runtime's whole, so a partial agent setting never inherits half a runtime one.
    expect(resolveAgentMemory({ ...BASE, runtime: { maxPerCall: 2 }, agent: { scope: 'session' } })).toMatchObject({ scope: 'session', maxPerCall: 3 });
  });

  it('refuses memory without a store, naming the agent', () => {
    expect(() => resolveAgentMemory({ ...BASE, hasStore: false, agent: true })).toThrow(expect.objectContaining({
      code: 'invalid_definition', message: expect.stringContaining("Agent 'helper' enables memory, which needs createAigent({ store })"),
    }));
  });

  it('refuses memory with captureContent off, since every memory is content', () => {
    expect(() => resolveAgentMemory({ ...BASE, captureContent: false, runtime: true })).toThrow(expect.objectContaining({
      code: 'invalid_definition', message: expect.stringContaining('captureContent: false'),
    }));
  });

  it('names the agent for invalid agent options', () => {
    expect(() => resolveAgentMemory({ ...BASE, agent: { maxEntries: 0 } })).toThrow(expect.objectContaining({ message: expect.stringContaining("Agent 'helper' has invalid memory options: maxEntries") }));
  });
});
