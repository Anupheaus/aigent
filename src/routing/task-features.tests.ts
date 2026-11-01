import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractTaskFeatures, featureBucket } from './task-features.js';

describe('extractTaskFeatures', () => {
  it('fills every feature from the task input', () => {
    const features = extractTaskFeatures({
      task: 'Find the config file and summarise its options', plan: [{ id: 'a', label: 'Look', description: 'Look around', acceptanceCriteria: ['seen'] }], acceptanceCriteria: ['names every option', 'is short'],
      output: z.object({ text: z.string() }), unattended: true, label: 'nightly',
    }, 4);
    expect(features).toEqual({
      length: 'short', hasPlan: true, acceptanceCriteria: 2, hasOutputSchema: true, toolCount: 4, unattended: true, label: 'nightly',
      keywordClasses: ['search', 'summarise'],
    });
  });

  it.each([
    // [task, expected classes]: the lexicon is word-based and case-insensitive.
    ['Where is the login handler defined?', ['search']],
    ['Rename the helper and fix the failing import', ['edit']],
    ['Explain why the build is slow', ['analyse']],
    ['Give me a TL;DR of the changelog', ['summarise']],
    ['Review the diff, then update the docs', ['analyse', 'edit']],
    ['Hello there', []],
    // "refinding" and "prefix" are not the words "find" and "fix".
    ['Refinding prefixes', []],
  ] as [string, string[]][])('classifies %j', (task, classes) => {
    expect(extractTaskFeatures({ task }).keywordClasses).toEqual(classes);
  });

  it('buckets length by the task and context characters', () => {
    expect(extractTaskFeatures({ task: 'x'.repeat(199) }).length).toBe('short');
    expect(extractTaskFeatures({ task: 'x'.repeat(150), context: 'y'.repeat(50) }).length).toBe('medium');
    expect(extractTaskFeatures({ task: 'x'.repeat(999) }).length).toBe('medium');
    expect(extractTaskFeatures({ task: 'x'.repeat(1_000) }).length).toBe('long');
  });

  it('defaults the flags and counts for a bare task', () => {
    expect(extractTaskFeatures({ task: 'hi' })).toEqual({ length: 'short', hasPlan: false, acceptanceCriteria: 0, hasOutputSchema: false, toolCount: 0, unattended: false, keywordClasses: [] });
  });
});

describe('featureBucket', () => {
  it('keys similar tasks alike and different kinds of work apart', () => {
    const search = featureBucket(extractTaskFeatures({ task: 'find the readme' }));
    expect(featureBucket(extractTaskFeatures({ task: 'please locate the license', acceptanceCriteria: ['x'] }, 9))).toBe(search);
    expect(featureBucket(extractTaskFeatures({ task: 'summarise the readme' }))).not.toBe(search);
    expect(featureBucket(extractTaskFeatures({ task: 'find '.repeat(300) }))).not.toBe(search);
    expect(search).toBe('short:search');
    expect(featureBucket(extractTaskFeatures({ task: 'hello' }))).toBe('short:general');
  });
});
