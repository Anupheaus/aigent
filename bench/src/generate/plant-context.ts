import { benchError } from '../bench-error.js';
import type { Prng } from '../prng.js';
import type { FamilyId, Manifest, ManifestItem, RepoSize, RepoTree, TreeEntry } from './repo-types.js';
import { NEUTRAL_WORDS, WORD_ENDINGS } from './vocabulary.js';

/** A route a family registers; the base layout writes the router files and mounts them. */
export interface RouteSpec {
  /** Router group: one router file `src/server/<group>-router.ts` per group. */
  group: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: { name: string; file: string };
  /** Written commented out (a decoy: not a live endpoint). */
  isCommented?: boolean;
}

/** A component the base `App.tsx` renders (imported by name from `file`). */
export interface AppSlot {
  name: string;
  file: string;
  /** Wraps the rest of the app (`<Name>{children}</Name>`) instead of being rendered as a leaf. */
  isWrapper?: boolean;
}

/** What a family planter writes through: files, manifest items, terms and the shared wiring. */
export interface PlantContext {
  family: FamilyId | 'base';
  prng: Prng;
  size: RepoSize;
  add(file: { path: string; content: TreeEntry; item?: Omit<ManifestItem, 'family' | 'path'> }): void;
  /** Adds a manifest item for a file written earlier (e.g. a needle that is also another task's decoy). */
  note(item: Omit<ManifestItem, 'family'>): void;
  term(key: string, value: string): void;
  criteria(key: string, value: { required: string[]; forbidden: string[] }): void;
  route(route: RouteSpec): void;
  slot(slot: AppSlot): void;
  /** Names re-exported from `src/index.ts`, so planted exports count as used (`file` is repo-relative). */
  publicExport(entry: { names: string[]; file: string }): void;
  /** A neutral word not used by any other planter. */
  freshWord(): string;
  exists(path: string): boolean;
}

/** The shared state planters write into; the generator reads it back once every family has planted. */
export interface PlantState {
  tree: RepoTree;
  manifest: Manifest;
  routes: RouteSpec[];
  slots: AppSlot[];
  publicExports: { names: string[]; file: string }[];
  usedWords: Set<string>;
}

export function createPlantState(params: { seed: number; size: RepoSize; families: FamilyId[] }): PlantState {
  const { seed, size, families } = params;
  return {
    tree: new Map(),
    manifest: { seed, size, families, items: [], terms: {}, criteria: {} },
    routes: [], slots: [], publicExports: [], usedWords: new Set(),
  };
}

/** A context bound to one family (or the base layout) with its own derived random source. */
export function createPlantContext(params: { state: PlantState; family: FamilyId | 'base'; prng: Prng }): PlantContext {
  const { state, family, prng } = params;
  const { tree, manifest } = state;
  return {
    family, prng, size: manifest.size,
    add: ({ path, content, item }) => {
      if (tree.has(path)) throw benchError(`generator: ${family} wrote '${path}', which another planter already wrote`, { family, path });
      tree.set(path, content);
      if (item != null) manifest.items.push({ family, path, ...item });
    },
    note: item => { manifest.items.push({ family, ...item }); },
    term: (key, value) => { manifest.terms[key] = value; },
    criteria: (key, value) => { manifest.criteria[key] = value; },
    route: route => { state.routes.push(route); },
    slot: slot => { state.slots.push(slot); },
    publicExport: entry => { state.publicExports.push(entry); },
    freshWord: () => {
      const singles = NEUTRAL_WORDS.filter(word => !state.usedWords.has(word));
      const available = singles.length > 0 ? singles : NEUTRAL_WORDS.flatMap(word => WORD_ENDINGS.map(ending => `${word}${ending}`)).filter(word => !state.usedWords.has(word));
      if (available.length === 0) throw benchError(`generator: ${family} ran out of neutral words (${state.usedWords.size} used)`, { family });
      const word = prng.pick(available);
      state.usedWords.add(word);
      return word;
    },
    exists: path => tree.has(path),
  };
}
