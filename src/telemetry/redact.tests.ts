import { describe, expect, it } from 'vitest';
import { applyRedact } from './redact.js';
import type { Redact } from './redact.js';

describe('applyRedact', () => {
  const record = { collection: 'runs', key: 'run_1', value: { task: 'secret task', nested: { list: ['secret'] } } };

  it('returns the record unchanged without a hook', () => {
    expect(applyRedact({ record })).toEqual(record);
  });

  it('applies the hook to the value and keeps the collection and key', () => {
    const redact: Redact = ({ collection, key, value }) => ({ collection, key, value: JSON.parse(JSON.stringify(value).replaceAll('secret', '[x]')) });
    expect(applyRedact({ redact, record })).toEqual({ collection: 'runs', key: 'run_1', value: { task: '[x] task', nested: { list: ['[x]'] } } });
  });

  it('hands the hook a copy, so a hook that mutates its input cannot change the caller\'s data', () => {
    const original = structuredClone(record);
    const redact: Redact = input => { (input.value as { task: string }).task = 'mutated'; return input; };
    expect(applyRedact({ redact, record })).toMatchObject({ value: { task: 'mutated' } });
    expect(record).toEqual(original);
  });

  it('refuses a hook that changes the collection or key, naming the record', () => {
    const moved: Redact = input => ({ ...input, key: 'other' });
    expect(() => applyRedact({ redact: moved, record })).toThrow(/redact.*'runs\/run_1'.*collection and key/);
    const notARecord = (() => 'oops') as unknown as Redact;
    expect(() => applyRedact({ redact: notARecord, record })).toThrow(/redact.*'runs\/run_1'/);
  });
});
