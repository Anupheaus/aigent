import { derivePrng } from '../prng.js';
import { plantFiller } from './layouts.js';
import { countFiles, hashTree, toDisk, toMemory } from './materialise.js';
import { FAMILY_PLANTERS } from './needles.js';
import { plantNoise, plantShell } from './noise.js';
import { createPlantContext, createPlantState } from './plant-context.js';
import type { PlantState } from './plant-context.js';
import { FAMILY_IDS } from './repo-types.js';
import type { FamilyId, GeneratedRepo, GenerateRepoParams, Manifest, RepoSize, RepoTree } from './repo-types.js';
import { writeWiring } from './wiring.js';

/** Files the wiring step adds after the filler (app shell, entry, server app, public barrel). */
const WIRING_FILES = 4;

/** The live endpoints (every registered, uncommented route) and the decoy ones, as `METHOD /path`. */
function endpointCriteria(state: PlantState): { required: string[]; forbidden: string[] } {
  const required = [...new Set(state.routes.filter(({ isCommented = false }) => !isCommented).map(({ method, path }) => `${method} ${path}`))].sort();
  const commented = state.routes.filter(({ isCommented = false }) => isCommented).map(({ method, path }) => `${method} ${path}`);
  const planted = state.manifest.criteria['endpoints-forbidden']?.forbidden ?? [];
  return { required, forbidden: [...new Set([...commented, ...planted])].filter(endpoint => !required.includes(endpoint)).sort() };
}

/** The generated tree and its manifest, deterministic from the seed: the same parameters give the same bytes. */
export function buildRepoTree(params: { seed: number; size: RepoSize; families: FamilyId[] }): { tree: RepoTree; manifest: Manifest } {
  const { seed, size, families } = params;
  const selected = FAMILY_IDS.filter(family => families.includes(family));
  const state = createPlantState({ seed, size, families: selected });
  const base = (label: string) => createPlantContext({ state, family: 'base', prng: derivePrng({ seed, label }) });
  plantShell(base('shell'));
  plantNoise(base('noise'));
  for (const family of selected) FAMILY_PLANTERS[family](createPlantContext({ state, family, prng: derivePrng({ seed, label: family }) }));
  plantFiller({ ctx: base('filler'), existingFiles: countFiles(state.tree) + WIRING_FILES + state.routes.length });
  writeWiring({ ctx: base('wiring'), state });
  const { manifest } = state;
  manifest.criteria = { ...manifest.criteria, endpoints: endpointCriteria(state) };
  delete manifest.criteria['endpoints-forbidden'];
  manifest.items.sort((first, second) => first.path.localeCompare(second.path) || (first.line ?? 0) - (second.line ?? 0) || first.reason.localeCompare(second.reason));
  return { tree: state.tree, manifest };
}

/**
 * Generates a repository with planted material for `families` (default target: an in-memory `FsAccess`, fast; `disk`
 * writes a temp directory and `cleanup` removes it).
 */
export async function generateRepo(params: GenerateRepoParams): Promise<GeneratedRepo> {
  const { seed, size, families, target = 'memory' } = params;
  const { tree, manifest } = buildRepoTree({ seed, size, families });
  const hash = hashTree(tree);
  const files = countFiles(tree);
  if (target === 'memory') return { ...toMemory(tree), files, manifest, tree, hash, cleanup: async () => undefined };
  const disk = await toDisk(tree);
  return { root: disk.root, access: disk.access, files, manifest, tree, hash, cleanup: disk.cleanup };
}
