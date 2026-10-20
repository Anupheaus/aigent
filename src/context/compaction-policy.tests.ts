import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPACTION_POLICY, parseCompactionPolicy } from './compaction-policy.js';

describe('parseCompactionPolicy', () => {
  it('fills the defaults', () => {
    expect(DEFAULT_COMPACTION_POLICY).toEqual({ compactAt: 0.75, compactTo: 0.45, keepRecent: 4, minSavingTokens: 500 });
    expect(parseCompactionPolicy({ agentName: 'a', policy: undefined })).toEqual(DEFAULT_COMPACTION_POLICY);
    expect(parseCompactionPolicy({ agentName: 'a', policy: { keepRecent: 2 } })).toEqual({ ...DEFAULT_COMPACTION_POLICY, keepRecent: 2 });
  });

  it.each([
    [{ compactAt: 1.2 }, /compactAt/],
    [{ compactTo: 0 }, /compactTo/],
    [{ compactAt: 0.5, compactTo: 0.5 }, /compactTo must be below compactAt/],
    [{ compactAt: 0.4 }, /compactTo must be below compactAt/],
    [{ keepRecent: 0 }, /keepRecent/],
    [{ minSavingTokens: -1 }, /minSavingTokens/],
    [{ extra: 1 }, /extra/],
  ])('rejects %o', (policy, message) => {
    expect(() => parseCompactionPolicy({ agentName: 'writer', policy: policy as never })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringMatching(message) }));
    expect(() => parseCompactionPolicy({ agentName: 'writer', policy: policy as never })).toThrow(/Agent 'writer'/);
  });
});
