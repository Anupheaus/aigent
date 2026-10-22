/** Precision, recall and F1 of a predicted set against the true set. */
export interface SetMetrics {
  precision: number;
  recall: number;
  f1: number;
  truePositives: string[];
  falsePositives: string[];
  missed: string[];
}

/**
 * Set metrics with the conventions the checker relies on: an empty prediction has precision 1 (it claimed nothing
 * false) and an empty truth has recall 1 (nothing was missed); F1 is 0 when either is 0.
 */
export function setMetrics(params: { predicted: readonly string[]; truth: readonly string[] }): SetMetrics {
  const predicted = [...new Set(params.predicted)];
  const truth = new Set(params.truth);
  const truePositives = predicted.filter(item => truth.has(item)).sort();
  const falsePositives = predicted.filter(item => !truth.has(item)).sort();
  const missed = [...truth].filter(item => !predicted.includes(item)).sort();
  const precision = predicted.length === 0 ? 1 : truePositives.length / predicted.length;
  const recall = truth.size === 0 ? 1 : truePositives.length / truth.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, truePositives, falsePositives, missed };
}

/** Repo-relative, `/`-separated, no leading `./` or `/`, no trailing slash: how answer paths are compared. */
export function normalisePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
}
