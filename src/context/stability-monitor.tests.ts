import { describe, expect, it } from 'vitest';
import type { ProviderMessage, ProviderToolSpec } from '../providers/provider-types.js';
import { computePrefixHash } from './prefix-hash.js';
import { createStabilityMonitor, PREFIX_CHANGED_WARNING } from './stability-monitor.js';

const TOOLS: ProviderToolSpec[] = [{ name: 'b', description: 'B', parameters: {}, strict: true }, { name: 'a', description: 'A', parameters: {}, strict: true }];
const SYSTEM: ProviderMessage = { role: 'system', text: 'rules' };
const BRIEF: ProviderMessage = { role: 'user', text: '# Task\nDo it' };

function warningsOf(run: (observe: ReturnType<typeof createStabilityMonitor>) => void): string[] {
  const warnings: string[] = [];
  run(createStabilityMonitor({ emit: event => { if (event.type === 'warning') warnings.push(event.message); }, isEnabled: true }));
  return warnings;
}

describe('computePrefixHash', () => {
  it('is a hex sha-256 that ignores tool order but not message content', () => {
    const hash = computePrefixHash([SYSTEM, BRIEF], TOOLS);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePrefixHash([SYSTEM, BRIEF], [...TOOLS].reverse())).toBe(hash);
    expect(computePrefixHash([SYSTEM, { ...BRIEF, text: 'other' }], TOOLS)).not.toBe(hash);
  });
});

describe('createStabilityMonitor', () => {
  it('stays quiet while history only grows at the tail', () => {
    expect(warningsOf(monitor => {
      monitor.observe({ messages: [SYSTEM, BRIEF], tools: TOOLS });
      monitor.observe({ messages: [SYSTEM, BRIEF, { role: 'assistant', text: 'a' }], tools: TOOLS });
      monitor.observe({ messages: [SYSTEM, BRIEF, { role: 'assistant', text: 'a' }, { role: 'user', text: 'b' }], tools: TOOLS });
    })).toEqual([]);
  });

  it('warns exactly once per run when an earlier message changes', () => {
    expect(warningsOf(monitor => {
      monitor.observe({ messages: [SYSTEM, BRIEF], tools: TOOLS });
      monitor.observe({ messages: [SYSTEM, { ...BRIEF, text: 'changed' }, { role: 'assistant', text: 'a' }], tools: TOOLS });
      monitor.observe({ messages: [{ ...SYSTEM, text: 'changed too' }], tools: TOOLS });
    })).toEqual([PREFIX_CHANGED_WARNING]);
  });

  it('warns when the tool specs change', () => {
    expect(warningsOf(monitor => {
      monitor.observe({ messages: [SYSTEM], tools: TOOLS });
      monitor.observe({ messages: [SYSTEM], tools: TOOLS.slice(1) });
    })).toEqual([PREFIX_CHANGED_WARNING]);
  });

  it('accepts one deliberate change (a rewritten pinned block or a compaction) without warning', () => {
    expect(warningsOf(monitor => {
      monitor.observe({ messages: [SYSTEM, BRIEF], tools: TOOLS });
      monitor.acceptChange();
      monitor.observe({ messages: [SYSTEM, { role: 'user', text: 'pinned' }, BRIEF], tools: TOOLS });
      monitor.observe({ messages: [SYSTEM, { role: 'user', text: 'pinned v2' }, BRIEF], tools: TOOLS });
    })).toEqual([PREFIX_CHANGED_WARNING]);
  });

  it('is silent when disabled (production)', () => {
    const warnings: string[] = [];
    const monitor = createStabilityMonitor({ emit: () => { warnings.push('x'); }, isEnabled: false });
    monitor.observe({ messages: [SYSTEM], tools: TOOLS });
    monitor.observe({ messages: [BRIEF], tools: TOOLS });
    expect(warnings).toEqual([]);
  });
});
