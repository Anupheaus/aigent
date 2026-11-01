import { describe, expect, it } from 'vitest';
import { lessonFromCorrection } from './corrections.js';

const TASK = 'Find the component that renders the invoice table';

describe('lessonFromCorrection', () => {
  it('makes no lesson from a correct rating or from a rating with nothing to learn', () => {
    expect(lessonFromCorrection({ feedback: { responseId: 'r', rating: 'correct', comment: 'great' }, task: TASK })).toBeUndefined();
    expect(lessonFromCorrection({ feedback: { responseId: 'r', rating: 'incorrect' }, task: TASK })).toBeUndefined();
  });

  it('treats a whitespace-only comment or expected answer as nothing to learn', () => {
    expect(lessonFromCorrection({ feedback: { responseId: 'r', rating: 'incorrect', comment: '   ' }, task: TASK })).toBeUndefined();
    expect(lessonFromCorrection({ feedback: { responseId: 'r', rating: 'incorrect', expectedAnswer: ' \n', comment: '\t' }, task: TASK })).toBeUndefined();
    expect(lessonFromCorrection({ feedback: { responseId: 'r', rating: 'incorrect', expectedAnswer: 'src/a.ts', comment: '  ' }, task: TASK })?.text).toBe('For "Find the component that renders the invoice table": the right answer was src/a.ts');
  });

  it('turns an expected answer and a comment into a lesson tied to the task', () => {
    expect(lessonFromCorrection({ feedback: { responseId: 'r', rating: 'incorrect', expectedAnswer: 'src/billing/InvoiceTable.tsx', comment: 'look in billing' }, task: TASK })).toEqual({
      kind: 'lesson',
      text: 'For "Find the component that renders the invoice table": the right answer was src/billing/InvoiceTable.tsx (look in billing)',
      tags: ['component', 'renders', 'invoice', 'table'],
    });
  });

  it('uses a comment alone for a partial rating', () => {
    expect(lessonFromCorrection({ feedback: { responseId: 'r', rating: 'partial', comment: 'also list the tests' }, task: TASK })?.text).toBe('For "Find the component that renders the invoice table": also list the tests');
  });

  it('cuts long text to 300 characters and long tasks to an excerpt', () => {
    const lesson = lessonFromCorrection({ feedback: { responseId: 'r', rating: 'incorrect', expectedAnswer: 'x'.repeat(1_000) }, task: `${'word '.repeat(40)}end` });
    expect(lesson?.text).toHaveLength(300);
    expect(lesson?.text.endsWith('…')).toBe(true);
    expect(lesson?.text).toMatch(/^For "(word ){15}word…": /);
  });

  it('still makes a lesson without the task text (no excerpt, no tags)', () => {
    expect(lessonFromCorrection({ feedback: { responseId: 'r', rating: 'incorrect', comment: 'wrong file' } })).toEqual({ kind: 'lesson', text: 'wrong file', tags: [] });
  });
});
