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

  it('builds an allow_always rule scoped to the call tool by default', () => {
    expect(ruleFromScope({ tool: 'write_file' })).toEqual({ tool: 'write_file' });
    expect(ruleFromScope({ tool: 'write_file', scope: { argsMatch: { path: 'a' } } })).toEqual({ tool: 'write_file', argsMatch: { path: 'a' } });
    expect(ruleFromScope({ tool: 'write_file', scope: { tool: '*' } })).toEqual({ tool: '*' });
  });
});
