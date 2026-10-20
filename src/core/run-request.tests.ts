import { describe, expect, it } from 'vitest';
import { createStabilityMonitor } from '../context/stability-monitor.js';
import { createFakeProvider } from '../testing/fake-provider.js';
import { createRunContext } from './run-context.js';
import { buildTurnRequest } from './run-request.js';
import type { RunVolatile } from './run-volatile.js';

const CLOCK = { now: () => 0 };

function volatile(extraText: string): RunVolatile {
  return {
    options: { dateTime: false }, maxTurns: 5, monitor: createStabilityMonitor({ emit: () => undefined, isEnabled: false }),
    extras: () => (extraText === '' ? [] : [{ title: 'Notes', body: extraText }]),
  };
}

function build(params: { extraText: string; usableBudget: number }) {
  const { extraText, usableBudget } = params;
  const context = createRunContext({ runId: 'r', createdAt: 0, initial: [{ kind: 'system', message: { role: 'system', text: 'rules' } }, { kind: 'brief', message: { role: 'user', text: 'task' } }] });
  const target = { label: 'fake:m', provider: createFakeProvider({ turns: [] }), model: 'm', warnings: [], dropped: [] };
  return () => buildTurnRequest({ context, tools: [], volatile: volatile(extraText), clock: CLOCK, target, usableBudget, progress: { turn: 1, toolCalls: 0, maxToolCalls: 10 } });
}

describe('buildTurnRequest', () => {
  it('builds a request that fits the usable budget', () => {
    expect(build({ extraText: '', usableBudget: 1_000 })().request.messages).toHaveLength(3);
  });

  it('refuses to send a request the volatile block pushed over the usable budget', () => {
    expect(build({ extraText: 'x'.repeat(8_000), usableBudget: 1_000 })).toThrow(expect.objectContaining({ code: 'context_overflow', details: expect.objectContaining({ usableBudget: 1_000 }) }));
  });
});
