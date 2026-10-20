import { describe, expect, it } from 'vitest';
import { decideByRules, needsApproval, ruleFromScope } from './approval-rules.js';
import type { ApprovalRule } from './approval-types.js';

const CONTEXT = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c', signal: new AbortController().signal };

describe('needsApproval', () => {
  it.each([
    [undefined, false],
    [false, false],
    [true, true],
    [(args: unknown) => (args as { path: string }).path.startsWith('/etc'), true],
    [{ reason: 'Deletes data' }, true],
    [{ when: () => false }, false],
  ])('%s → %s', (requiresApproval, expected) => {
    expect(needsApproval({ requiresApproval, args: { path: '/etc/x' }, context: CONTEXT })).toBe(expected);
  });
});

describe('decideByRules', () => {
  const allowWrites: ApprovalRule = { tool: 'write_file' };
  const denyEtc: ApprovalRule = { tool: 'write_file', argsMatch: { path: '/etc/hosts' } };
  const denyAll: ApprovalRule = { tool: '*', when: args => (args as { force?: boolean }).force === true };

  it.each([
    ['no rules', [], [], { path: 'a' }, 'ask'],
    ['an allow rule', [allowWrites], [], { path: 'a' }, 'allow'],
    ['deny beats allow', [allowWrites], [denyEtc], { path: '/etc/hosts' }, 'deny'],
    ['a deny that does not match', [allowWrites], [denyEtc], { path: 'b' }, 'allow'],
    ['a wildcard deny with when', [allowWrites], [denyAll], { path: 'b', force: true }, 'deny'],
    ['an allow for another tool', [{ tool: 'read_file' }], [], { path: 'a' }, 'ask'],
    ['argsMatch needs every key', [{ tool: 'write_file', argsMatch: { path: 'a', mode: 'w' } }], [], { path: 'a' }, 'ask'],
  ])('%s', (_name, allow, deny, args, expected) => {
    expect(decideByRules({ tool: 'write_file', args, rules: { allow, deny } })).toBe(expected);
  });

  // Replaces a test that locked in the old, too-wide default (any arguments) and allowed scope.tool '*'.
  it('builds an allow_always rule for the call tool with exactly these arguments by default', () => {
    const exact = ruleFromScope({ tool: 'write_file', args: { path: 'a', mode: 'w' } });
    expect(decideByRules({ tool: 'write_file', args: { mode: 'w', path: 'a' }, rules: { allow: [exact] } })).toBe('allow');
    expect(decideByRules({ tool: 'write_file', args: { path: 'a', mode: 'x' }, rules: { allow: [exact] } })).toBe('ask');
    expect(decideByRules({ tool: 'read_file', args: { path: 'a', mode: 'w' }, rules: { allow: [exact] } })).toBe('ask');
    const narrowed = ruleFromScope({ tool: 'write_file', args: { path: 'a' }, scope: { argsMatch: { path: 'a' } } });
    expect(decideByRules({ tool: 'write_file', args: { path: 'a', mode: 'x' }, rules: { allow: [narrowed] } })).toBe('allow');
    const any = ruleFromScope({ tool: 'write_file', args: { path: 'a' }, scope: { anyArgs: true } });
    expect(decideByRules({ tool: 'write_file', args: { path: 'z' }, rules: { allow: [any] } })).toBe('allow');
  });

  it('refuses an allow_always scope that names another tool', () => {
    expect(() => ruleFromScope({ tool: 'write_file', args: {}, scope: { tool: '*' } })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => ruleFromScope({ tool: 'write_file', args: {}, scope: { tool: 'delete_file' } })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(ruleFromScope({ tool: 'write_file', args: {}, scope: { tool: 'write_file', anyArgs: true } })).toMatchObject({ tool: 'write_file' });
  });
});
