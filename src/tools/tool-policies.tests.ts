import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool.js';
import { resumePolicyOf } from './tool-policies.js';

const base = { description: 'd', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 't' }), run: async () => 1 };

describe('tool resume policy', () => {
  it('defaults to rerun for read-only tools and ask for tools with side effects', () => {
    expect(resumePolicyOf(defineTool({ ...base, name: 'read' }))).toBe('rerun');
    expect(resumePolicyOf(defineTool({ ...base, name: 'write', hasSideEffects: true }))).toBe('ask');
    expect(resumePolicyOf(defineTool({ ...base, name: 'pay', hasSideEffects: true, resume: 'skip' }))).toBe('skip');
  });

  it('requires verify for resume: verify and validates the policy', () => {
    expect(() => defineTool({ ...base, name: 'pay', hasSideEffects: true, resume: 'verify' })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining("resume 'verify' needs a verify function") }));
    expect(() => defineTool({ ...base, name: 'pay', resume: 'later' as never })).toThrow(expect.objectContaining({ message: expect.stringContaining('resume must be one of rerun, verify, ask, skip') }));
    expect(() => defineTool({ ...base, name: 'pay', verify: 'x' as never })).toThrow(expect.objectContaining({ message: expect.stringContaining('verify must be a function') }));
    const verified = defineTool({ ...base, name: 'pay', hasSideEffects: true, resume: 'verify', verify: async () => ({ done: true, result: 'paid' }) });
    expect(verified.resume).toBe('verify');
    expect(typeof verified.verify).toBe('function');
  });
});
