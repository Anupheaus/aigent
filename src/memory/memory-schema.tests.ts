import { describe, expect, it } from 'vitest';
import { parseMemoryNotes, resolveMemoryOptions, retrieverOf } from './memory-schema.js';
import type { MemoryOptions } from './memory-types.js';

// Session by default: sharing memory across sessions (and so across users) is opted into with scope 'agent'.
const DEFAULTS = { scope: 'session', maxEntries: 200, maxPerCall: 3, halfLifeDays: 30, minConfidence: 0.2, recallLimit: 6 };

describe('resolveMemoryOptions', () => {
  it('is off unless memory is asked for', () => {
    expect(resolveMemoryOptions({ owner: 'createAigent', options: undefined })).toBeUndefined();
    expect(resolveMemoryOptions({ owner: 'createAigent', options: false })).toBeUndefined();
  });

  it('fills every default for true or partial options', () => {
    expect(resolveMemoryOptions({ owner: 'createAigent', options: true })).toEqual(DEFAULTS);
    expect(resolveMemoryOptions({ owner: 'createAigent', options: { scope: 'agent', maxPerCall: 2 } })).toEqual({ ...DEFAULTS, scope: 'agent', maxPerCall: 2 });
  });

  it.each([
    [{ maxPerCall: 0 }, 'maxPerCall'],
    [{ maxEntries: 1.5 }, 'maxEntries'],
    [{ minConfidence: 2 }, 'minConfidence'],
    [{ scope: 'tenant' }, 'scope'],
    [{ recall: 3 }, 'recall'],
  ])('refuses %j naming the field and the owner', (options, field) => {
    // Consumers may call from plain JavaScript, so invalid shapes are passed through a cast on purpose.
    expect(() => resolveMemoryOptions({ owner: "Agent 'helper'", options: options as MemoryOptions })).toThrow(expect.objectContaining({
      code: 'invalid_definition', message: expect.stringMatching(new RegExp(`Agent 'helper'.*${field}`)),
    }));
  });
});

describe('retrieverOf', () => {
  it('accepts a retriever with rank, keeps it out of the resolved settings, and refuses one without', () => {
    const retriever = { rank: async () => [] };
    expect(resolveMemoryOptions({ owner: 'createAigent', options: { retriever } })).toEqual(DEFAULTS);
    expect(retrieverOf({ retriever })).toBe(retriever);
    expect(retrieverOf(true)).toBeUndefined();
    expect(() => resolveMemoryOptions({ owner: 'createAigent', options: { retriever: {} } as unknown as MemoryOptions })).toThrow(expect.objectContaining({ message: expect.stringContaining('retriever') }));
  });
});

describe('parseMemoryNotes', () => {
  it('has nothing to save for an absent or null field', () => {
    expect(parseMemoryNotes({ value: undefined, maxPerCall: 3 })).toEqual({ notes: [], problems: [] });
    expect(parseMemoryNotes({ value: null, maxPerCall: 3 })).toEqual({ notes: [], problems: [] });
  });

  it('keeps valid notes and treats null tags and pinned as absent', () => {
    const value = [{ kind: 'fact', text: 'The API lives in apps/api', tags: ['api'], pinned: null }, { kind: 'lesson', text: 'Run the linter first', tags: null }];
    expect(parseMemoryNotes({ value, maxPerCall: 3 })).toEqual({
      notes: [{ kind: 'fact', text: 'The API lives in apps/api', tags: ['api'] }, { kind: 'lesson', text: 'Run the linter first' }],
      problems: [],
    });
  });

  it('never lets the model pin: a pinned note is kept unpinned, saying so', () => {
    const value = [{ kind: 'lesson', text: 'Run the linter first', tags: null, pinned: true }];
    expect(parseMemoryNotes({ value, maxPerCall: 3 })).toEqual({
      notes: [{ kind: 'lesson', text: 'Run the linter first' }],
      problems: ['memory note 1 was saved unpinned: only the application can pin a memory'],
    });
  });

  it('keeps the first maxPerCall notes and says which ones were dropped', () => {
    const value = ['a', 'b', 'c', 'd', 'e'].map(text => ({ kind: 'fact', text }));
    const { notes, problems } = parseMemoryNotes({ value, maxPerCall: 3 });
    expect(notes.map(({ text }) => text)).toEqual(['a', 'b', 'c']);
    expect(problems).toEqual(['5 memory notes sent but at most 3 are accepted per call; notes 4 and 5 were not saved']);
  });

  it('skips each invalid note with its position and the reason, keeping the valid ones', () => {
    const value = [
      { kind: 'fact', text: 'x'.repeat(301) },
      { kind: 'rumour', text: 'y' },
      { kind: 'fact', text: 'ok', tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { kind: 'fact', text: 'ok', tags: ['t'.repeat(25)] },
      { kind: 'fact', text: '' },
      { kind: 'fact', text: 'kept' },
    ];
    const { notes, problems } = parseMemoryNotes({ value, maxPerCall: 10 });
    expect(notes).toEqual([{ kind: 'fact', text: 'kept' }]);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatch(/^memory note 1 was not saved: .*text.*300/);
    expect(problems[1]).toMatch(/^memory note 2 was not saved: .*kind/);
    expect(problems[2]).toMatch(/^memory note 3 was not saved: .*tags.*5/);
    expect(problems[3]).toMatch(/^memory note 4 was not saved: .*tags.*24/);
    expect(problems[4]).toMatch(/^memory note 5 was not saved: .*text/);
  });

  it('refuses a field that is not a list', () => {
    expect(parseMemoryNotes({ value: { kind: 'fact', text: 'x' }, maxPerCall: 3 })).toEqual({ notes: [], problems: ['memory must be a list of notes or null; nothing was saved'] });
  });

  it('rejects unknown keys in a note', () => {
    const { notes, problems } = parseMemoryNotes({ value: [{ kind: 'fact', text: 'x', scope: 'global' }], maxPerCall: 3 });
    expect(notes).toEqual([]);
    expect(problems[0]).toMatch(/scope/);
  });
});
