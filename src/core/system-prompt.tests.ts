import { describe, expect, it } from 'vitest';
import { FEEDBACK_PROMPT_ADDENDUM } from '../feedback/feedback-prompt.js';
import { buildSystemPrompt } from './system-prompt.js';

describe('buildSystemPrompt', () => {
  it('orders library rules, persona, skillset and context, omitting empty ones', () => {
    const prompt = buildSystemPrompt({ persona: 'P', skillset: 'S', context: 'C' });
    expect(prompt.indexOf('P')).toBeLessThan(prompt.indexOf('S'));
    expect(prompt).toMatch(/Persona[\s\S]*P[\s\S]*Skillset[\s\S]*S[\s\S]*Environment[\s\S]*C/);
    expect(buildSystemPrompt({})).not.toMatch(/Persona|Skillset|Environment/);
  });

  it('adds tool addenda after the library rules and before the persona, each once and sorted', () => {
    const prompt = buildSystemPrompt({ persona: 'P', toolAddenda: ['Zeta rule.', 'Alpha rule.', 'Zeta rule.'] });
    expect(prompt.match(/Zeta rule\./g)).toHaveLength(1);
    expect(prompt.indexOf('Alpha rule.')).toBeLessThan(prompt.indexOf('Zeta rule.'));
    expect(prompt.indexOf('Zeta rule.')).toBeLessThan(prompt.indexOf('# Persona'));
    expect(buildSystemPrompt({ persona: 'P', toolAddenda: [] })).toBe(buildSystemPrompt({ persona: 'P' }));
  });

  it('is byte-stable for the same input', () => {
    expect(buildSystemPrompt({ persona: 'P' })).toBe(buildSystemPrompt({ persona: 'P' }));
  });

  it('describes aigent_multi calls as { id, tool, args } with an args object, not a JSON string', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('"args": {the argument object for that tool}');
    expect(prompt).not.toContain('argsJson');
  });

  it('documents the directive syntax when feedback is enabled', () => {
    expect(buildSystemPrompt({ enableFeedback: true })).toContain('::aigent');
  });

  it('adds the feedback addendum to the stable prefix only when feedback is enabled', () => {
    const plain = buildSystemPrompt({ persona: 'P' });
    expect(buildSystemPrompt({ persona: 'P', enableFeedback: false })).toBe(plain);
    for (const phrase of ['::aigent', 'previous', 'aigent_feedback']) expect(plain).not.toContain(phrase);
    const withFeedback = buildSystemPrompt({ persona: 'P', enableFeedback: true });
    expect(withFeedback).toContain(FEEDBACK_PROMPT_ADDENDUM);
    // Library rules and the addendum come before the agent's own text, so the cached prefix is shared across agents.
    expect(withFeedback.indexOf(FEEDBACK_PROMPT_ADDENDUM)).toBeLessThan(withFeedback.indexOf('# Persona'));
    expect(buildSystemPrompt({ persona: 'P', enableFeedback: true })).toBe(withFeedback);
  });
});
