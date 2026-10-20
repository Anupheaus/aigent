import { describe, expect, it } from 'vitest';
import { blockFor, chargeAdmission, createKeyState } from './key-state.js';

const NOW = 1_000_000;

describe('createKeyState', () => {
  it('starts idle, with budgets only for the per-minute limits that are set', () => {
    const unlimited = createKeyState({});
    expect(unlimited).toMatchObject({ inFlight: 0, pausedUntil: 0, halvedAdmissionsLeft: 0, waiters: [] });
    expect(unlimited.requestBudget).toBeUndefined();
    expect(unlimited.tokenBudget).toBeUndefined();
    const limited = createKeyState({ requestsPerMinute: 2, tokensPerMinute: 100 });
    expect(limited.requestBudget).toBeDefined();
    expect(limited.tokenBudget).toBeDefined();
  });
});

describe('blockFor', () => {
  it('admits anything without limits', () => {
    expect(blockFor({ state: createKeyState({}), estimatedTokens: 1_000_000, now: NOW })).toBeUndefined();
  });

  it('blocks on concurrency without a known wait', () => {
    const state = createKeyState({ maxConcurrent: 1 });
    state.inFlight = 1;
    expect(blockFor({ state, estimatedTokens: 1, now: NOW })).toEqual({ reason: 'concurrency' });
  });

  it('reports a 429 pause as requests-per-minute with the time left, ahead of everything else', () => {
    const state = createKeyState({ maxConcurrent: 1 });
    state.inFlight = 1;
    state.pausedUntil = NOW + 2_500;
    expect(blockFor({ state, estimatedTokens: 1, now: NOW })).toEqual({ reason: 'requests-per-minute', waitMs: 2_500 });
  });

  it('halves maxConcurrent (at least 1) while recovering from a 429', () => {
    const state = createKeyState({ maxConcurrent: 4 });
    state.halvedAdmissionsLeft = 3;
    state.inFlight = 2;
    expect(blockFor({ state, estimatedTokens: 1, now: NOW })).toEqual({ reason: 'concurrency' });
    const single = createKeyState({ maxConcurrent: 1 });
    single.halvedAdmissionsLeft = 3;
    expect(blockFor({ state: single, estimatedTokens: 1, now: NOW })).toBeUndefined();
  });

  it('blocks on the request budget with the wait until a slot returns', () => {
    const state = createKeyState({ requestsPerMinute: 1 });
    chargeAdmission({ state, estimatedTokens: 1, now: NOW });
    state.inFlight = 0;
    expect(blockFor({ state, estimatedTokens: 1, now: NOW + 10_000 })).toEqual({ reason: 'requests-per-minute', waitMs: 50_000 });
  });

  it('blocks on the token budget with the wait until enough tokens return', () => {
    const state = createKeyState({ tokensPerMinute: 100 });
    chargeAdmission({ state, estimatedTokens: 80, now: NOW });
    expect(blockFor({ state, estimatedTokens: 30, now: NOW + 1_000 })).toEqual({ reason: 'tokens-per-minute', waitMs: 59_000 });
    expect(blockFor({ state, estimatedTokens: 20, now: NOW + 1_000 })).toBeUndefined();
  });
});

describe('chargeAdmission', () => {
  it('takes a slot, one request, the estimated tokens and one halved admission', () => {
    const state = createKeyState({ requestsPerMinute: 10, tokensPerMinute: 100 });
    state.halvedAdmissionsLeft = 2;
    chargeAdmission({ state, estimatedTokens: 40, now: NOW });
    expect(state.inFlight).toBe(1);
    expect(state.halvedAdmissionsLeft).toBe(1);
    expect(state.requestBudget?.used(NOW)).toBe(1);
    expect(state.tokenBudget?.used(NOW)).toBe(40);
  });

  it('returns a function that replaces the token estimate with the actual usage', () => {
    const state = createKeyState({ tokensPerMinute: 100 });
    const reconcile = chargeAdmission({ state, estimatedTokens: 40, now: NOW });
    reconcile(15);
    expect(state.tokenBudget?.used(NOW)).toBe(15);
  });
});
