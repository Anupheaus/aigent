import type { AliasTable } from '../alias-table.js';
import type { Shaper } from '../shaper-types.js';

/** A long string earns an alias once it appears this often in one result (or already has one). */
const MIN_OCCURRENCES = 2;

function countStrings(value: unknown, counts: Map<string, number>): void {
  if (typeof value === 'string') { counts.set(value, (counts.get(value) ?? 0) + 1); return; }
  if (Array.isArray(value)) { for (const entry of value) countStrings(entry, counts); return; }
  if (typeof value === 'object' && value !== null) for (const entry of Object.values(value)) countStrings(entry, counts);
}

function replaceStrings(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map(entry => replaceStrings(entry, replacements));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, replacements)]));
  return value;
}

/** Long string values (never keys) that repeat in the result or were aliased by an earlier result. */
function aliasable(params: { value: unknown; aliases: AliasTable }): string[] {
  const { value, aliases } = params;
  const counts = new Map<string, number>();
  countStrings(value, counts);
  return [...counts.entries()]
    .filter(([text, count]) => text.length >= aliases.minLength && (count >= MIN_OCCURRENCES || aliases.has(text)))
    .map(([text]) => text);
}

/** structured-data, search-hits: long repeated strings become aliases `F1`... that the model may also write in arguments. */
export const aliasesShaper: Shaper = {
  name: 'aliases',
  appliesTo: ['structured-data', 'search-hits'],
  shape: ({ value, context: { aliases } }) => {
    if (typeof value !== 'object' || value === null) return undefined;
    const texts = aliasable({ value, aliases });
    if (texts.length === 0) return undefined;
    const replacements = new Map(texts.map(text => [text, aliases.aliasFor(text)]));
    const legend = [...replacements.entries()].map(([text, alias]) => `${alias} = ${JSON.stringify(text)}`).join('; ');
    return { value: replaceStrings(value, replacements), note: `Aliases (usable in arguments): ${legend}` };
  },
};
