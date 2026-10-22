import { benchError } from '../bench-error.js';
import { budgetsFrom } from '../check/tiers.js';
import type { Manifest, RepoSize } from '../generate/repo-types.js';
import { benchRepo } from '../harness/repo-cache.js';
import { runTask } from '../harness/run-task.js';
import { goodPolicy } from '../solvers/policies/good.js';
import { createScriptedSolver } from '../solvers/scripted-solver.js';
import type { DecoyRef, TaskSpec } from '../task-spec.js';
import { computeTruth } from '../truth/compute-truth.js';
import { CATALOGUE, DECLARED_MS, VARIANT_GRID } from './catalogue.js';
import type { CatalogueTask } from './catalogue.js';
import { HELD_OUT_VARIANT, PHRASINGS, VARIANT_IDS } from './variants.js';
import type { VariantId } from './variants.js';

/** The reference solver budgets are measured with (the expert policy on the Round-0 tools). */
export const REFERENCE_SOLVER = createScriptedSolver({ id: 'reference', policy: goodPolicy });

/** Every (task, variant, seed, size) the catalogue defines; held-out entries only when asked. */
export function catalogueEntries(params: { heldOut: boolean }): { task: CatalogueTask; variant: VariantId; seed: number; size: RepoSize }[] {
  const variants: VariantId[] = params.heldOut ? [...VARIANT_IDS, HELD_OUT_VARIANT] : [...VARIANT_IDS];
  return CATALOGUE.flatMap(task => variants.flatMap(variant => VARIANT_GRID[variant].map(({ seed, size }) => ({ task, variant, seed, size: variant === HELD_OUT_VARIANT ? size : task.sizes?.[variant] ?? size }))));
}

function decoysOf(params: { manifest: Manifest; task: CatalogueTask }): DecoyRef[] {
  const { manifest, task: { query } } = params;
  const files = manifest.items.filter(({ decoyFor = [] }) => decoyFor.includes(query)).map(({ path, reason, line }) => ({ path, reason, ...(line == null ? {} : { line }) }));
  const items = (manifest.criteria[query]?.forbidden ?? []).map(item => ({ path: '', reason: 'listed but not a correct item', item }));
  return [...files, ...items];
}

/** The spec of one catalogue entry without its measured reference (prompt, truth, decoys, acceptance, trap). */
export async function draftSpec(params: { task: CatalogueTask; variant: VariantId; seed: number; size: RepoSize }): Promise<Omit<TaskSpec, 'budgets' | 'reference'>> {
  const { task, variant, seed, size } = params;
  const { manifest, tree } = await benchRepo({ seed, size });
  const term = task.termKey == null ? undefined : manifest.terms[task.termKey];
  if (task.termKey != null && term == null) throw benchError(`buildSpecs: repository s${seed}/${size} has no term '${task.termKey}' for task '${task.id}'`, { task: task.id, seed, size });
  const phrasing = PHRASINGS[task.id]?.[variant];
  if (phrasing == null) throw benchError(`buildSpecs: task '${task.id}' has no '${variant}' phrasing`, { task: task.id, variant });
  const trap = task.trap?.(manifest);
  return {
    id: `${task.id}/${variant}/${size}/s${seed}`, family: task.id, variant, prompt: phrasing.replace('{term}', term ?? ''), scope: ['.'], query: task.query,
    repo: { seed, size }, heldOut: variant === HELD_OUT_VARIANT, givenTerms: term == null ? [] : [term],
    groundTruth: computeTruth({ tree, manifest, query: task.query }), decoys: decoysOf({ manifest, task }),
    accept: { kind: task.accept, minRecall: 1, minPrecision: 1 },
    ...(trap == null ? {} : { trap }),
  };
}

/**
 * A full spec: the draft, plus the reference solution measured by running the reference policy on the generated
 * repository, and budgets derived from it (target 1.5x, pass 4x, stretch 0.8x). Refuses when the reference is wrong on
 * a tuning spec; on a held-out spec a wrong reference is a finding of the held-out run, so it is recorded instead.
 */
export async function buildSpec(params: { task: CatalogueTask; variant: VariantId; seed: number; size: RepoSize }): Promise<TaskSpec> {
  const draft = await draftSpec(params);
  const provisional: TaskSpec = { ...draft, budgets: budgetsFrom({ tokens: 1, turns: 1, toolCalls: 1, ms: 1 }), reference: { description: params.task.reference, steps: [], measured: { tokens: 0, turns: 0, toolCalls: 0, ms: 0 } } };
  const row = await runTask({ spec: provisional, solver: REFERENCE_SOLVER });
  if (!row.correct && !draft.heldOut) throw benchError(`buildSpecs: the reference solution is wrong on '${draft.id}': ${row.failures.join('; ')}`, { id: draft.id });
  const measured = { tokens: row.tokens, turns: row.turns, toolCalls: row.toolCalls, ms: DECLARED_MS[params.size] };
  const steps = Object.entries(row.tools).sort(([first], [second]) => first.localeCompare(second)).map(([tool, { calls, items }]) => ({ tool, items, purpose: `${calls} call(s)` }));
  return { ...draft, budgets: budgetsFrom(measured), reference: { description: params.task.reference, steps, measured, ...(row.correct ? {} : { failures: row.failures }) } };
}

/** The catalogue entries `buildSpecs` builds: the tuning specs, or (only when asked) the held-out ones, never both. */
export function entriesToBuild(params: { heldOut: boolean; tasks?: string[] }): ReturnType<typeof catalogueEntries> {
  const { heldOut, tasks } = params;
  return catalogueEntries({ heldOut: true }).filter(({ task, variant }) => (variant === HELD_OUT_VARIANT) === heldOut && (tasks == null || tasks.includes(task.id)));
}

/** The tuning specs, or the held-out ones, in id order (deterministic: same code and seeds give byte-identical JSON). */
export async function buildSpecs(params: { heldOut: boolean; tasks?: string[] }): Promise<TaskSpec[]> {
  const specs: TaskSpec[] = [];
  for (const entry of entriesToBuild(params)) specs.push(await buildSpec(entry));
  return specs.sort((first, second) => first.id.localeCompare(second.id));
}

/**
 * The committed specs with the rebuilt ones in their place: a rebuilt family's committed specs of the rebuilt kind
 * (tuning or held-out) are all replaced, since a wording or grid change may rename them; everything else is kept.
 */
export function replaceSpecs(params: { committed: TaskSpec[]; rebuilt: TaskSpec[] }): TaskSpec[] {
  const { committed, rebuilt } = params;
  const replaced = new Set(rebuilt.map(({ family, heldOut }) => `${family}\u0000${heldOut}`));
  const kept = committed.filter(({ family, heldOut }) => !replaced.has(`${family}\u0000${heldOut}`));
  return [...kept, ...rebuilt].sort((first, second) => first.id.localeCompare(second.id));
}
