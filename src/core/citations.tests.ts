import { describe, expect, it } from 'vitest';
import { applyCitations } from './citations.js';
import type { Citation } from './citations.js';

const citation = (chunkId: string): Citation => ({ sourceId: `s-${chunkId}`, chunkId, uri: `docs/${chunkId}`, span: { start: 0, end: 10 } });
const known = new Map([['abc123', citation('abc123')], ['def456', citation('def456')]]);

describe('applyCitations', () => {
  it('strips markers and returns the cited passages in order of first citation, each once', () => {
    const result = applyCitations({ answer: 'Backups run nightly [[cite:def456]]. They are kept 35 days [[cite:abc123]] [[cite:def456]].', known });
    expect(result).toEqual({ answer: 'Backups run nightly. They are kept 35 days.', citations: [citation('def456'), citation('abc123')], unknown: [] });
  });

  it('drops unknown ids (reporting them) and leaves malformed markers alone', () => {
    const result = applyCitations({ answer: 'A [[cite:zzz999]] B [[cite:]] C [[cite: abc123]] D [[cite:abc123] E [cite:abc123]', known });
    expect(result.unknown).toEqual(['zzz999']);
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe('A B [[cite:]] C [[cite: abc123]] D [[cite:abc123] E [cite:abc123]');
  });

  it('leaves markers inside inline code and fenced code blocks as written (review M7)', () => {
    const answer = 'Cite with `[[cite:abc123]]` like this [[cite:abc123]].\n\n```md\nSee [[cite:def456]]\n```\nDone [[cite:def456]].';
    const result = applyCitations({ answer, known });
    expect(result.answer).toBe('Cite with `[[cite:abc123]]` like this.\n\n```md\nSee [[cite:def456]]\n```\nDone.');
    expect(result.citations).toEqual([citation('abc123'), citation('def456')]);
  });

  it('returns an answer without markers unchanged', () => {
    expect(applyCitations({ answer: 'No sources needed.', known })).toEqual({ answer: 'No sources needed.', citations: [], unknown: [] });
  });
});
