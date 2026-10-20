import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './system-prompt.js';

describe('buildSystemPrompt', () => {
  it('orders library rules, persona, skillset and context, omitting empty ones', () => {
    const prompt = buildSystemPrompt({ persona: 'P', skillset: 'S', context: 'C' });
    expect(prompt.indexOf('P')).toBeLessThan(prompt.indexOf('S'));
    expect(prompt).toMatch(/Persona[\s\S]*P[\s\S]*Skillset[\s\S]*S[\s\S]*Environment[\s\S]*C/);
    expect(buildSystemPrompt({})).not.toMatch(/Persona|Skillset|Environment/);
  });

  it('is byte-stable for the same input', () => {
    expect(buildSystemPrompt({ persona: 'P' })).toBe(buildSystemPrompt({ persona: 'P' }));
  });

  it('documents the directive syntax', () => {
    expect(buildSystemPrompt({})).toContain('::aigent');
  });
});
