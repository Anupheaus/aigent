import { describe, expect, it } from 'vitest';
import { budgetsFrom } from '../check/tiers.js';
import { benchRepo } from '../harness/repo-cache.js';
import { lintAgentTexts, lintTask } from '../lint/hint-linter.js';
import { MODEL_PERSONA, MODEL_SKILLSET } from '../model-solver.js';
import { readPrompt } from '../solvers/read-prompt.js';
import type { TaskSpec } from '../task-spec.js';
import { CATALOGUE } from './catalogue.js';
import { draftSpec } from './build-specs.js';
import { readSpecs } from './spec-files.js';
import { HELD_OUT_VARIANT, PHRASINGS, VARIANT_IDS } from './variants.js';
import type { VariantId } from './variants.js';

const MIN_FAMILIES = 14;
const MIN_VARIANTS = 3;
/** The intent a prompt must be read as, per truth query. */
const INTENT_OF: Record<string, string> = {
  'find-file': 'find-file', 'none-exist': 'find-file', ambiguous: 'find-file', 'string-usage': 'string-usage', 'string-any-case': 'string-any-case', 'string-word': 'string-word',
  'string-noisy': 'string-noisy', theme: 'theme', react: 'react', 'ui-customer': 'ui-customer', gdpr: 'gdpr', bugs: 'bugs', symbol: 'symbol', 'route-trace': 'route-trace', endpoints: 'endpoints',
  'env-var': 'env-var', 'tests-for': 'tests-for', 'dead-exports': 'dead-exports', 'pii-fields': 'pii-fields',
};
const intentOf = (query: string): string => INTENT_OF[query] ?? 'string-usage';

const specs: TaskSpec[] = await readSpecs();

describe('task catalogue', () => {
  it(`has at least ${MIN_FAMILIES} task families with at least ${MIN_VARIANTS} run variants each, plus held-out ones`, () => {
    const families = new Set(specs.map(({ family }) => family));
    expect(families.size).toBeGreaterThanOrEqual(MIN_FAMILIES);
    for (const family of families) {
      const variants = new Set(specs.filter(spec => spec.family === family && !spec.heldOut).map(({ variant }) => variant));
      expect(variants.size, family).toBeGreaterThanOrEqual(MIN_VARIANTS);
      expect(specs.some(spec => spec.family === family && spec.heldOut && spec.repo.seed >= 1_000), `${family} held out`).toBe(true);
    }
    expect(specs.filter(({ heldOut }) => heldOut).every(({ variant }) => variant === HELD_OUT_VARIANT)).toBe(true);
    expect(new Set(specs.map(({ repo: { size } }) => size))).toEqual(new Set(['small', 'medium', 'large']));
  });

  it('every spec passes the hint linter, and so do the bench agent texts', async () => {
    for (const spec of specs) expect(lintTask(spec, (await benchRepo(spec.repo)).manifest), spec.id).toEqual([]);
    for (const seed of [1, 2, 3]) expect(lintAgentTexts({ texts: { persona: MODEL_PERSONA, skillset: MODEL_SKILLSET }, manifest: (await benchRepo({ seed, size: 'small' })).manifest })).toEqual([]);
  });

  it('phrases every task in four styles plus a held-out one, each read as the intended question', () => {
    for (const task of CATALOGUE) {
      for (const variant of [...VARIANT_IDS, HELD_OUT_VARIANT] as VariantId[]) {
        const prompt = PHRASINGS[task.id]?.[variant]?.replace('{term}', task.termKey == null ? '' : 'probeTerm') ?? '';
        if (task.termKey == null) expect(readPrompt(prompt)?.kind, `${task.id}/${variant}`).toBe(intentOf(task.query));
      }
    }
    for (const spec of specs) expect(readPrompt(spec.prompt)?.kind, spec.id).toBe(intentOf(spec.query));
  });

  it('derives budgets from the measured reference only (target 1.5x, pass 4x, stretch 0.8x)', () => {
    for (const spec of specs) expect(spec.budgets, spec.id).toEqual(budgetsFrom(spec.reference.measured));
  });

  it('matches the deterministic builder: committed prompts, truth, decoys and traps regenerate byte for byte', async () => {
    for (const spec of specs) {
      const task = CATALOGUE.find(({ id }) => id === spec.family);
      expect(task, spec.family).toBeDefined();
      if (task == null) continue;
      const { budgets: _budgets, reference: _reference, ...committed } = spec;
      const draft = await draftSpec({ task, variant: spec.variant as VariantId, seed: spec.repo.seed, size: spec.repo.size });
      expect(JSON.stringify(draft), spec.id).toBe(JSON.stringify(committed));
    }
  });
});
