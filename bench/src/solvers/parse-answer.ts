import type { SolverAnswer } from '../task-spec.js';

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');

/** The structured answer in a model's final text: the first JSON object of a known shape, or the text itself. */
export function parseAnswer(text: string): SolverAnswer | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      if (parsed['none'] === true) return { none: true };
      if (isStringArray(parsed['files'])) return { files: parsed['files'] };
      if (Array.isArray(parsed['bugs'])) {
        return { bugs: (parsed['bugs'] as Record<string, unknown>[]).map(bug => ({ path: String(bug['path'] ?? ''), line: Number(bug['line'] ?? 0), cause: String(bug['cause'] ?? '') })) };
      }
      if (typeof parsed['text'] === 'string') return { text: parsed['text'] };
    } catch {
      // Not JSON: the answer is the text itself.
    }
  }
  return text.trim() === '' ? undefined : { text };
}
