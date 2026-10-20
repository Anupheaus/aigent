/** Prefix of every alias token (`F1`, `F2`...). */
const ALIAS_PREFIX = 'F';
const ALIAS_TOKEN = /^F[1-9][0-9]*$/;

/** The checkpointable form of an alias table. */
export interface AliasTableJson {
  minLength: number;
  /** `[alias, text]` in assignment order. */
  entries: [string, string][];
}

export interface CreateAliasTableParams {
  /** Shortest string worth an alias. */
  minLength: number;
}

/**
 * Run state: short stable aliases for long strings repeated in lossy-ok tool results, so the model reads (and writes)
 * `F1` instead of the full text. Never used for file content.
 */
export interface AliasTable {
  readonly minLength: number;
  /** The text's alias, assigning the next one when it has none. */
  aliasFor(text: string): string;
  has(text: string): boolean;
  /** The text behind an alias, or undefined for an unknown token. */
  valueOf(alias: string): string | undefined;
  size(): number;
  toJSON(): AliasTableJson;
}

function buildTable(json: AliasTableJson): AliasTable {
  const { minLength } = json;
  const byText = new Map<string, string>();
  const byAlias = new Map<string, string>();
  for (const [alias, text] of json.entries) {
    byText.set(text, alias);
    byAlias.set(alias, text);
  }

  function aliasFor(text: string): string {
    const existing = byText.get(text);
    if (existing != null) return existing;
    const alias = `${ALIAS_PREFIX}${byAlias.size + 1}`;
    byText.set(text, alias);
    byAlias.set(alias, text);
    return alias;
  }

  return {
    minLength,
    aliasFor,
    has: text => byText.has(text),
    valueOf: alias => byAlias.get(alias),
    size: () => byAlias.size,
    toJSON: () => ({ minLength, entries: [...byAlias.entries()] }),
  };
}

export function createAliasTable(params: CreateAliasTableParams): AliasTable {
  const { minLength } = params;
  return buildTable({ minLength, entries: [] });
}

/** Restores a table saved with `toJSON`. */
export function aliasTableFromJSON(json: AliasTableJson): AliasTable {
  return buildTable(json);
}

function expandValue(value: unknown, table: AliasTable): unknown {
  if (typeof value === 'string') return ALIAS_TOKEN.test(value) ? table.valueOf(value) ?? value : value;
  if (Array.isArray(value)) return value.map(entry => expandValue(entry, table));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandValue(entry, table)]));
  return value;
}

/**
 * Replaces argument strings that are exactly a known alias token with the text behind it, at any depth (strings only;
 * keys, substrings and unknown tokens are left alone). Returns new arguments; the input is not changed.
 */
export function expandAliases(args: unknown, table: AliasTable): unknown {
  if (table.size() === 0) return args;
  return expandValue(args, table);
}
