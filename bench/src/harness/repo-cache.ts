import { generateRepo } from '../generate/repo-generator.js';
import { FAMILY_IDS } from '../generate/repo-types.js';
import type { GeneratedRepo, RepoSize } from '../generate/repo-types.js';

const cache = new Map<string, Promise<GeneratedRepo>>();

/**
 * The repository for a seed and size with every family, generated once per process (in memory). Bench runs only read
 * it; trap wrappers sit on top of its access, never inside it.
 */
export function benchRepo(params: { seed: number; size: RepoSize }): Promise<GeneratedRepo> {
  const { seed, size } = params;
  const key = `${seed}:${size}`;
  const existing = cache.get(key);
  if (existing != null) return existing;
  const created = generateRepo({ seed, size, families: [...FAMILY_IDS] });
  cache.set(key, created);
  return created;
}
