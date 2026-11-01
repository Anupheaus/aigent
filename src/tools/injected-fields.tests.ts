import { describe, expect, it } from 'vitest';
import { splitInjectedField, stripInjectedFields, stripInnerField } from './injected-fields.js';

describe('injected wrapper fields', () => {
  it('splits a field out without mutating the arguments', () => {
    const args = { path: 'a', previous: { success: true } };
    expect(splitInjectedField({ args, field: 'previous' })).toEqual({ args: { path: 'a' }, value: { success: true } });
    expect(args).toEqual({ path: 'a', previous: { success: true } });
  });

  it('leaves arguments that are not an object as they are', () => {
    expect(splitInjectedField({ args: 'text', field: 'previous' })).toEqual({ args: 'text', value: undefined });
    expect(splitInjectedField({ args: [1], field: 'previous' })).toEqual({ args: [1], value: undefined });
  });

  it('strips inner aigent_multi calls and names the ones that carried the field, null included', () => {
    const multiArgs = { calls: [{ id: 'a', tool: 't', args: { k: 1, memory: null } }, { id: 'b', tool: 't', args: { k: 2 } }] };
    expect(stripInnerField({ args: multiArgs, field: 'memory' })).toEqual({
      args: { calls: [{ id: 'a', tool: 't', args: { k: 1 } }, { id: 'b', tool: 't', args: { k: 2 } }] },
      strippedCallIds: ['a'],
    });
  });

  it('strips every named field from a call, and from inner calls only of aigent_multi', () => {
    const multi = { id: 'm', name: 'aigent_multi', args: { previous: null, memory: [], calls: [{ id: 'a', tool: 't', args: { k: 1, previous: null, memory: [] } }] } };
    expect(stripInjectedFields({ call: multi, fields: ['previous', 'memory'] }).args).toEqual({ calls: [{ id: 'a', tool: 't', args: { k: 1 } }] });
    const plain = { id: 'p', name: 'other', args: { calls: [{ id: 'a', args: { previous: 1 } }], previous: 1 } };
    expect(stripInjectedFields({ call: plain, fields: ['previous'] }).args).toEqual({ calls: [{ id: 'a', args: { previous: 1 } }] });
  });

  it('returns the same call when there is nothing to strip', () => {
    const call = { id: 'p', name: 'other', args: { k: 1 } };
    expect(stripInjectedFields({ call, fields: [] })).toBe(call);
  });
});
