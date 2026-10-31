import { describe, expect, it } from 'vitest';
import { splitMemory, stripInnerMemory } from './split-memory.js';

describe('splitMemory', () => {
  it('takes memory out without touching the input', () => {
    const raw = { path: 'a', memory: [{ kind: 'fact', text: 'x' }] };
    expect(splitMemory(raw)).toEqual({ args: { path: 'a' }, value: [{ kind: 'fact', text: 'x' }], isPresent: true });
    expect(raw).toHaveProperty('memory');
  });

  it('reports a null or absent field as absent, still removing the key', () => {
    expect(splitMemory({ path: 'a', memory: null })).toEqual({ args: { path: 'a' }, value: null, isPresent: false });
    expect(splitMemory({ path: 'a' })).toEqual({ args: { path: 'a' }, value: undefined, isPresent: false });
  });

  it('leaves arguments that are not an object alone', () => {
    expect(splitMemory('text')).toEqual({ args: 'text', value: undefined, isPresent: false });
  });
});

describe('stripInnerMemory', () => {
  it('removes memory from inner aigent_multi calls and names them', () => {
    const multiArgs = { calls: [{ id: 'one', tool: 'read', args: { path: 'a', memory: [] } }, { id: 'two', tool: 'read', args: { path: 'b' } }, { id: 'three', tool: 'read', args: { memory: null } }] };
    expect(stripInnerMemory(multiArgs)).toEqual({
      args: { calls: [{ id: 'one', tool: 'read', args: { path: 'a' } }, { id: 'two', tool: 'read', args: { path: 'b' } }, { id: 'three', tool: 'read', args: {} }] },
      strippedCallIds: ['one', 'three'],
    });
    expect(multiArgs.calls[0]?.args).toHaveProperty('memory');
  });

  it('ignores arguments without a calls list', () => {
    expect(stripInnerMemory({ other: true })).toEqual({ args: { other: true }, strippedCallIds: [] });
  });
});
