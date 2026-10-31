import { describe, expect, it } from 'vitest';
import { interfaceKeyOf, memoryScopeKey } from './scope-key.js';

describe('memoryScopeKey', () => {
  it('shares agent scope across every run and session of the agent', () => {
    expect(memoryScopeKey({ scope: 'agent', runId: 'run_1', sessionId: 's1' })).toBe('agent');
    expect(memoryScopeKey({ scope: 'agent', runId: 'run_2' })).toBe('agent');
  });

  it('keys session scope on the chat session, and a task on its own run', () => {
    expect(memoryScopeKey({ scope: 'session', runId: 'run_1', sessionId: 's1' })).toBe('session:s1');
    expect(memoryScopeKey({ scope: 'session', runId: 'run_1' })).toBe('session:run_1');
  });

  it('keys interface scope on the consumer key', () => {
    expect(memoryScopeKey({ scope: 'interface', runId: 'run_1', interfaceKey: 'slack' })).toBe('interface:slack');
  });

  it('refuses interface scope without a key', () => {
    expect(() => memoryScopeKey({ scope: 'interface', runId: 'run_1' })).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('memoryScopeKey') }));
  });
});

describe('interfaceKeyOf', () => {
  it('prefers memoryScopeKey, then scope.interface', () => {
    expect(interfaceKeyOf({ memoryScopeKey: 'cli', scope: { interface: 'web' } })).toBe('cli');
    expect(interfaceKeyOf({ scope: { interface: 'web' } })).toBe('web');
    expect(interfaceKeyOf({})).toBeUndefined();
  });
});
