import { describe, expect, it } from 'vitest';
import { classifyCause } from './cause-class.js';
import { checkResult } from './check-result.js';
import { specWith } from './spec.test-support.js';

describe('checkResult: file sets', () => {
  const spec = specWith({ groundTruth: { kind: 'files', files: ['src/a.ts', 'src/b.ts'] }, decoys: [{ path: 'dist/a.js', reason: 'build output' }] });

  it('passes the exact set, in any order and spelling', () => {
    expect(checkResult(spec, { files: ['.\\src\\b.ts', 'src/a.ts'] })).toMatchObject({ correct: true, precision: 1, recall: 1, decoyHits: 0 });
  });

  it('fails a decoy hit and counts it, and fails a miss', () => {
    expect(checkResult(spec, { files: ['src/a.ts', 'src/b.ts', 'dist/a.js'] })).toMatchObject({ correct: false, decoyHits: 1, falsePositives: ['dist/a.js'] });
    expect(checkResult(spec, { files: ['src/a.ts'] })).toMatchObject({ correct: false, recall: 0.5, missed: ['src/b.ts'] });
  });

  it('honours lower thresholds and rejects the wrong answer shape', () => {
    const lenient = specWith({ groundTruth: { kind: 'files', files: ['a', 'b'] }, accept: { minRecall: 0.5, minPrecision: 0.5 } });
    expect(checkResult(lenient, { files: ['a', 'x'] }).correct).toBe(true);
    expect(checkResult(spec, { text: 'src/a.ts' })).toMatchObject({ correct: false, reason: 'expected a list of files' });
    expect(checkResult(spec, undefined)).toMatchObject({ correct: false, reason: 'no answer' });
  });

  it('accepts any listed alternative', () => {
    const ambiguous = specWith({ groundTruth: { kind: 'files', files: ['x/a.ts', 'y/a.ts'], alternatives: [['x/a.ts'], ['y/a.ts'], ['x/a.ts', 'y/a.ts']] } });
    expect(checkResult(ambiguous, { files: ['y/a.ts'] }).correct).toBe(true);
    expect(checkResult(ambiguous, { files: ['x/a.ts', 'y/a.ts'] }).correct).toBe(true);
    expect(checkResult(ambiguous, { files: ['x/a.ts', 'z/a.ts'] }).correct).toBe(false);
  });
});

describe('checkResult: none exist', () => {
  const spec = specWith({ groundTruth: { kind: 'none' }, accept: { kind: 'none-exist' }, decoys: [{ path: 'src/a.old.ts', reason: 'old copy' }] });

  it('passes "none" and an empty list, fails an invented file', () => {
    expect(checkResult(spec, { none: true }).correct).toBe(true);
    expect(checkResult(spec, { files: [] }).correct).toBe(true);
    expect(checkResult(spec, { files: ['src/a.old.ts'] })).toMatchObject({ correct: false, decoyHits: 1 });
  });
});

describe('checkResult: bugs', () => {
  const spec = specWith({
    groundTruth: { kind: 'bugs', bugs: [{ path: 'src/a.ts', line: 10, cause: 'off-by-one' }, { path: 'src/b.ts', line: 4, cause: 'injection' }] },
    accept: { kind: 'bugs' },
    decoys: [{ path: 'src/a.ts', line: 30, reason: 'correct bound' }],
  });

  it('matches by location within 3 lines and by cause class, not wording', () => {
    expect(checkResult(spec, { bugs: [{ path: 'src/a.ts', line: 13, cause: 'loop runs one past the end of the array' }, { path: 'src/b.ts', line: 4, cause: 'SQL built from user input' }] }).correct).toBe(true);
    expect(checkResult(spec, { bugs: [{ path: 'src/a.ts', line: 14, cause: 'off-by-one' }, { path: 'src/b.ts', line: 4, cause: 'injection' }] }).correct).toBe(false);
    expect(checkResult(spec, { bugs: [{ path: 'src/a.ts', line: 10, cause: 'swallowed error' }, { path: 'src/b.ts', line: 4, cause: 'injection' }] }).correct).toBe(false);
  });

  it('counts a flagged look-alike as a false positive and a decoy hit', () => {
    const result = checkResult(spec, { bugs: [{ path: 'src/a.ts', line: 10, cause: 'off-by-one' }, { path: 'src/b.ts', line: 4, cause: 'injection' }, { path: 'src/a.ts', line: 31, cause: 'off-by-one' }] });
    expect(result).toMatchObject({ correct: false, decoyHits: 1, recall: 1 });
    expect(result.precision).toBeCloseTo(2 / 3);
  });

  it('classifies free-text causes', () => {
    expect(classifyCause('handle is never closed')).toBe('resource-leak');
    expect(classifyCause('uses local hours instead of UTC')).toBe('timezone');
    expect(classifyCause('|| makes it always true')).toBe('wrong-operator');
    expect(classifyCause('user may be undefined after find')).toBe('null-deref');
    expect(classifyCause('nothing')).toBeUndefined();
  });
});

describe('checkResult: criteria', () => {
  it('extracts endpoints from text and counts unlisted ones as false positives', () => {
    const spec = specWith({ groundTruth: { kind: 'criteria', itemKind: 'endpoint', required: ['GET /api/a', 'GET /api/a/:id'], forbidden: ['DELETE /api/a/:id/legacy'] }, accept: { kind: 'criteria' } });
    expect(checkResult(spec, { text: 'GET /api/a\nget /api/a/:id' }).correct).toBe(true);
    expect(checkResult(spec, { text: 'GET /api/a, GET /api/a/:id, DELETE /api/a/:id/legacy' })).toMatchObject({ correct: false, decoyHits: 1 });
    expect(checkResult(spec, { text: 'GET /api/a/:id' }).correct).toBe(false);
  });

  it('extracts identifiers, ignoring prose words', () => {
    const spec = specWith({ groundTruth: { kind: 'criteria', itemKind: 'identifier', required: ['padCedar', 'trimCedar'], forbidden: ['foldCedar'] }, accept: { kind: 'criteria' } });
    expect(checkResult(spec, { text: 'The unused ones are padCedar and trimCedar.' }).correct).toBe(true);
    expect(checkResult(spec, { text: 'padCedar trimCedar foldCedar' })).toMatchObject({ correct: false, decoyHits: 1 });
  });
});
