import { describe, expect, it } from 'vitest';
import type { Manifest } from '../generate/repo-types.js';
import { specWith } from '../check/spec.test-support.js';
import { lintAgentTexts, lintTask, lintText } from './hint-linter.js';

const ANSWER = 'src/billing/kestrel/ledgerSnapshot.ts';
const manifest: Manifest = {
  seed: 1, size: 'small', families: ['file-find', 'react', 'theme'], terms: {}, criteria: { endpoints: { required: ['GET /api/orbits'], forbidden: [] } },
  items: [
    { family: 'file-find', kind: 'needle', path: ANSWER, reason: 'needle', answers: ['string-usage'], distinctive: ['cedarTierCode'] },
    { family: 'react', kind: 'decoy', path: 'src/ui/Panel.tsx', reason: 'decoy' },
    { family: 'theme', kind: 'decoy', path: 'src/ui/theme/x.ts', reason: 'decoy' },
  ],
};
const spec = (prompt: string, extra: { scope?: string[]; context?: string; givenTerms?: string[] } = {}) => ({ ...specWith({ groundTruth: { kind: 'files', files: [ANSWER] } }), prompt, scope: extra.scope ?? ['.'], givenTerms: extra.givenTerms ?? [], ...(extra.context == null ? {} : { context: extra.context }) });
const kinds = (prompt: string, extra?: Parameters<typeof spec>[1]): string[] => lintTask(spec(prompt, extra), manifest).map(({ kind }) => kind);

describe('hint linter', () => {
  it('passes a natural prompt with no pointers', () => {
    expect(lintTask(spec('Which source files use the tier code field in code?'), manifest)).toEqual([]);
  });

  it.each([
    ['the full answer path', `Look at ${ANSWER} first`, 'answer-path'],
    ['a backslash spelling of the path', 'Look at SRC\\BILLING\\KESTREL\\ledgerSnapshot.ts', 'answer-path'],
    ['a folder of the answer', 'It is somewhere in the kestrel folder', 'path-segment'],
    ['the folder name in another case', 'check BILLING', 'path-segment'],
    ['a 6-character piece of the file name', 'something about a snapshot', 'segment-substring'],
    ['a distinctive identifier', 'find cedarTierCode', 'distinctive'],
  ])('fails %s', (_label, prompt, kind) => {
    expect(kinds(prompt)).toContain(kind);
  });

  it('lints scope and context too, and requires a broad scope', () => {
    expect(kinds('Which files?', { scope: ['src/billing'] })).toContain('scope');
    expect(kinds('Which files?', { scope: ['docs'] })).toContain('scope');
    expect(kinds('Which files?', { scope: ['src'] })).toEqual([]);
    expect(kinds('Which files?', { context: 'The team keeps billing code apart.' })).toContain('path-segment');
  });

  it('masks the user\'s own given terms but refuses given terms that carry answer folders', () => {
    expect(kinds('Where is ledgerSnapshot.ts?', { givenTerms: ['ledgerSnapshot.ts'] })).toEqual([]);
    expect(kinds('Where is ledgerSnapshot.ts?')).not.toEqual([]);
    expect(kinds('Where is kestrel/ledgerSnapshot.ts?', { givenTerms: ['kestrel/ledgerSnapshot.ts'] })).toContain('given-term');
  });

  it('lints agent persona and skillset against every answer, including criteria items', () => {
    expect(lintAgentTexts({ texts: { persona: 'You are careful.', skillset: 'Search first, then read.' }, manifest })).toEqual([]);
    expect(lintAgentTexts({ texts: { skillset: 'Endpoints live under GET /api/orbits' }, manifest }).map(({ field }) => field)).toEqual(['skillset']);
    expect(lintText({ field: 'context', text: 'see LEDGERSNAPSHOT', sources: { paths: [ANSWER], distinctive: [] } }).map(({ kind }) => kind)).toContain('path-segment');
  });
});
