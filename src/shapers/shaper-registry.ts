import { createAigentError } from '../core/aigent-error.js';
import { aliasesShaper } from './builtin/aliases.js';
import { dedupeReadsShaper } from './builtin/dedupe-reads.js';
import { foldRepeatsShaper } from './builtin/fold-repeats.js';
import { htmlBoilerplateShaper } from './builtin/html-boilerplate.js';
import { stripNoiseShaper } from './builtin/strip-noise.js';
import { tabularShaper } from './builtin/tabular.js';
import { CONTENT_KINDS } from './shaper-types.js';
import type { Shaper } from './shaper-types.js';

/** Built-in shapers in pipeline order: dedupe first (it replaces the whole result), aliasing last. */
const BUILTIN_SHAPERS: readonly Shaper[] = [dedupeReadsShaper, stripNoiseShaper, foldRepeatsShaper, htmlBoilerplateShaper, tabularShaper, aliasesShaper];

/** Names accepted by `shapers: { allow }`. */
export const BUILTIN_SHAPER_NAMES: readonly string[] = BUILTIN_SHAPERS.map(({ name }) => name);

/** The shapers a pipeline runs, in order. */
export interface ShaperRegistry {
  /** Throws `invalid_definition` for a shaper without a non-empty `appliesTo` of known kinds, or a duplicate name. */
  registerShaper(shaper: Shaper): void;
  list(): Shaper[];
  names(): string[];
}

function invalidShaper(params: { name: string; message: string }): never {
  const { name, message } = params;
  throw createAigentError({ code: 'invalid_definition', message: `Shaper '${name}': ${message}`, details: { shaper: name } });
}

/** The CI-gate equivalent: no shaper may run without declaring exactly which content kinds it touches. */
function validateShaper(shaper: Shaper): void {
  const { name, appliesTo, shape } = shaper as Partial<Shaper>;
  const label = String(name);
  if (typeof name !== 'string' || name === '') invalidShaper({ name: label, message: 'name must be a non-empty string' });
  if (typeof shape !== 'function') invalidShaper({ name: label, message: 'shape must be a function' });
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) invalidShaper({ name: label, message: `appliesTo is required and must list at least one of ${CONTENT_KINDS.join(', ')}` });
  const unknown = appliesTo.filter(kind => !(CONTENT_KINDS as readonly string[]).includes(kind));
  if (unknown.length > 0) invalidShaper({ name: label, message: `appliesTo has unknown kinds ${unknown.join(', ')}; expected ${CONTENT_KINDS.join(', ')}` });
}

export function createShaperRegistry(shapers: readonly Shaper[]): ShaperRegistry {
  const registered: Shaper[] = [];

  function registerShaper(shaper: Shaper): void {
    validateShaper(shaper);
    if (registered.some(({ name }) => name === shaper.name)) invalidShaper({ name: shaper.name, message: 'Duplicate shaper name' });
    registered.push(shaper);
  }

  for (const shaper of shapers) registerShaper(shaper);
  return { registerShaper, list: () => [...registered], names: () => registered.map(({ name }) => name) };
}

/** A registry holding the built-in shapers. */
export function createBuiltinShaperRegistry(): ShaperRegistry {
  return createShaperRegistry(BUILTIN_SHAPERS);
}
