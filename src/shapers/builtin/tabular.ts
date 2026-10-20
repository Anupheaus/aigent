import type { Shaper } from '../shaper-types.js';

/** Fewest rows worth a table. */
const MIN_ROWS = 3;

type Cell = string | number | boolean | null;

/** The compact form of an array of flat objects that share one key set. */
export interface TabularValue {
  columns: string[];
  rows: Cell[][];
}

function isCell(value: unknown): value is Cell {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isFlatObject(value: unknown): value is Record<string, Cell> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isCell);
}

/** The shared key set (in the first object's order) when every object has exactly those keys. */
function sharedColumns(objects: Record<string, Cell>[]): string[] | undefined {
  const [first] = objects;
  if (first == null) return undefined;
  const columns = Object.keys(first);
  const isHomogeneous = objects.every(object => {
    const keys = Object.keys(object);
    return keys.length === columns.length && columns.every(column => column in object);
  });
  return isHomogeneous ? columns : undefined;
}

/** Rebuilds the objects from a tabular value; the round trip is lossless (cells are never dropped). */
export function decodeTabular(value: TabularValue): Record<string, Cell>[] {
  const { columns, rows } = value;
  return rows.map(row => Object.fromEntries(columns.map((column, columnIndex) => [column, row[columnIndex] ?? null])));
}

/** structured-data: three or more homogeneous flat objects become `{ columns, rows }`, so keys are not repeated per row. */
export const tabularShaper: Shaper = {
  name: 'tabular',
  appliesTo: ['structured-data'],
  shape: ({ value, context }) => {
    if (!Array.isArray(value) || value.length < MIN_ROWS || !value.every(isFlatObject)) return undefined;
    const columns = sharedColumns(value);
    if (columns == null) return undefined;
    const rows = value.map(object => columns.map(column => object[column] as Cell));
    return { value: { columns, rows }, note: `${rows.length} rows as columns + rows (each row lists its values in column order); full result: handle ${context.originalHandle()}` };
  },
};
