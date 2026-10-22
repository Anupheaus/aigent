import type { BugTruth, GroundTruth } from '../truth/truth-types.js';
import type { SolverAnswer, TaskSpec } from '../task-spec.js';
import { classifyCause } from './cause-class.js';
import { normalisePath, setMetrics } from './set-metrics.js';
import type { SetMetrics } from './set-metrics.js';

/** How far (in lines) a reported bug may be from the real one and still match. */
export const BUG_LINE_TOLERANCE = 3;
const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,;)`'"]*)/gi;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
/** camelCase-looking tokens: counted as claimed identifiers (prose words are not). */
const CODE_LIKE = /^[a-z]+[A-Z]\w*$/;

/** Correctness of one answer: set metrics, decoy hits and why it failed. Efficiency is judged separately (`tierOf`). */
export interface CheckResult {
  correct: boolean;
  precision: number;
  recall: number;
  f1: number;
  /** Answered items that are planted decoys. */
  decoyHits: number;
  falsePositives: string[];
  missed: string[];
  reason?: string;
}

const fail = (reason: string): CheckResult => ({ correct: false, precision: 0, recall: 0, f1: 0, decoyHits: 0, falsePositives: [], missed: [], reason });

function judge(params: { spec: TaskSpec; metrics: SetMetrics; decoyHits: number }): CheckResult {
  const { spec: { accept }, metrics: { precision, recall, f1, falsePositives, missed }, decoyHits } = params;
  const correct = recall >= accept.minRecall && precision >= accept.minPrecision;
  return { correct, precision, recall, f1, decoyHits, falsePositives, missed, ...(correct ? {} : { reason: `recall ${recall.toFixed(2)} (min ${accept.minRecall}), precision ${precision.toFixed(2)} (min ${accept.minPrecision})` }) };
}

function checkFiles(params: { spec: TaskSpec; truth: Extract<GroundTruth, { kind: 'files' }>; answer: SolverAnswer }): CheckResult {
  const { spec, truth, answer } = params;
  if ('none' in answer) return judge({ spec, metrics: setMetrics({ predicted: [], truth: truth.files }), decoyHits: 0 });
  if (!('files' in answer)) return fail('expected a list of files');
  const predicted = answer.files.map(normalisePath);
  const candidates = truth.alternatives ?? [truth.files];
  // With several acceptable answers, the answer is judged against the alternative it matches best.
  const best = candidates.map(files => setMetrics({ predicted, truth: files })).sort((first, second) => second.f1 - first.f1)[0] ?? setMetrics({ predicted, truth: truth.files });
  const decoys = new Set(spec.decoys.map(({ path }) => path));
  return judge({ spec, metrics: best, decoyHits: predicted.filter(path => decoys.has(path)).length });
}

function checkNone(params: { spec: TaskSpec; answer: SolverAnswer }): CheckResult {
  const { spec, answer } = params;
  const claimed = 'files' in answer ? answer.files.map(normalisePath) : [];
  if ('none' in answer || claimed.length === 0) return { correct: true, precision: 1, recall: 1, f1: 1, decoyHits: 0, falsePositives: [], missed: [] };
  const decoys = new Set(spec.decoys.map(({ path }) => path));
  return { ...fail('the right answer is that none exist'), falsePositives: claimed, decoyHits: claimed.filter(path => decoys.has(path)).length };
}

/** Matches each reported bug to at most one real bug at the same path, within the line tolerance and of the same cause. */
function checkBugs(params: { spec: TaskSpec; bugs: BugTruth[]; answer: SolverAnswer }): CheckResult {
  const { spec, bugs, answer } = params;
  const reported = 'bugs' in answer ? answer.bugs : 'none' in answer ? [] : undefined;
  if (reported == null) return fail('expected a list of bugs');
  const unmatched = [...bugs];
  const falsePositives: string[] = [];
  const near = (first: { path: string; line: number }, second: { path: string; line: number }): boolean => normalisePath(first.path) === second.path && Math.abs(first.line - second.line) <= BUG_LINE_TOLERANCE;
  for (const bug of reported) {
    const cause = classifyCause(bug.cause);
    const match = unmatched.findIndex(real => near(bug, real) && real.cause === cause);
    if (match >= 0) unmatched.splice(match, 1);
    else falsePositives.push(`${normalisePath(bug.path)}:${bug.line} (${bug.cause})`);
  }
  const found = bugs.length - unmatched.length;
  const precision = reported.length === 0 ? 1 : found / reported.length;
  const recall = bugs.length === 0 ? 1 : found / bugs.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const decoyHits = reported.filter(bug => spec.decoys.some(decoy => decoy.line != null && near(bug, { path: decoy.path, line: decoy.line }))).length;
  return judge({ spec, metrics: { precision, recall, f1, truePositives: [], falsePositives, missed: unmatched.map(({ path, line, cause }) => `${path}:${line} (${cause})`) }, decoyHits });
}

/** Items listed in a text answer: `METHOD /path` endpoints, or code-like identifiers (and any planted item named). */
function extractItems(params: { text: string; truth: Extract<GroundTruth, { kind: 'criteria' }> }): string[] {
  const { text, truth } = params;
  if (truth.itemKind === 'endpoint') return [...text.matchAll(ENDPOINT)].map(match => `${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`);
  const known = new Set([...truth.required, ...truth.forbidden]);
  return (text.match(IDENTIFIER) ?? []).filter(token => known.has(token) || CODE_LIKE.test(token));
}

function checkCriteria(params: { spec: TaskSpec; truth: Extract<GroundTruth, { kind: 'criteria' }>; answer: SolverAnswer }): CheckResult {
  const { spec, truth, answer } = params;
  if (!('text' in answer)) return fail('expected a text answer');
  const items = extractItems({ text: answer.text, truth });
  const forbidden = new Set(truth.forbidden);
  return judge({ spec, metrics: setMetrics({ predicted: items, truth: truth.required }), decoyHits: [...new Set(items)].filter(item => forbidden.has(item)).length });
}

/** Judges an answer against the spec's ground truth (correctness only). */
export function checkResult(spec: TaskSpec, answer: SolverAnswer | undefined): CheckResult {
  if (answer == null) return fail('no answer');
  const { groundTruth } = spec;
  switch (groundTruth.kind) {
    case 'files': return checkFiles({ spec, truth: groundTruth, answer });
    case 'none': return checkNone({ spec, answer });
    case 'bugs': return checkBugs({ spec, bugs: groundTruth.bugs, answer });
    case 'criteria': return checkCriteria({ spec, truth: groundTruth, answer });
  }
}
