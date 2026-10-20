import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool } from '../../tool-types.js';
import { parseCsv } from '../csv.js';
import { DATA_TOOL_BASE, guarded } from './data-shared.js';

export const CSV_QUERY_TOOL_NAME = 'csv_query';
const MAX_ROWS = 1_000;
const DEFAULT_ROWS = 100;

const csvItem = z.object({
  csv: z.string().describe('The CSV text (RFC 4180: quotes, embedded newlines, CRLF and a BOM are handled)'),
  header: z.boolean().optional().describe('First row names the columns (default true); otherwise columns are column1, column2...'),
  select: z.array(z.string().min(1)).min(1).optional().describe('Columns to return, in order (default all)'),
  where: z.array(z.object({
    column: z.string().min(1),
    op: z.enum(['eq', 'ne', 'gt', 'lt', 'contains', 'startsWith']),
    value: z.string(),
  }).strict()).optional().describe('Every condition must hold; gt/lt compare as numbers when both sides are numbers'),
  orderBy: z.object({ column: z.string().min(1), direction: z.enum(['asc', 'desc']).optional() }).strict().optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Most rows to return (default ${DEFAULT_ROWS})`),
}).strict();

type Condition = NonNullable<z.infer<typeof csvItem>['where']>[number];

const isNumeric = (value: string): boolean => value.trim() !== '' && Number.isFinite(Number(value));

/** Numbers compare as numbers, anything else as text. */
function order(left: string, right: string): number {
  if (isNumeric(left) && isNumeric(right)) return Number(left) - Number(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function holds(params: { cell: string; condition: Condition }): boolean {
  const { cell, condition: { op, value } } = params;
  switch (op) {
    case 'eq': return isNumeric(cell) && isNumeric(value) ? Number(cell) === Number(value) : cell === value;
    case 'ne': return isNumeric(cell) && isNumeric(value) ? Number(cell) !== Number(value) : cell !== value;
    case 'gt': return order(cell, value) > 0;
    case 'lt': return order(cell, value) < 0;
    case 'contains': return cell.includes(value);
    case 'startsWith': return cell.startsWith(value);
  }
}

/** `csv_query`: select, filter, order and limit the rows of CSV text. */
export function createCsvQuery(): Tool {
  return defineBatchTool({
    ...DATA_TOOL_BASE,
    name: CSV_QUERY_TOOL_NAME,
    description: 'Query CSV text: choose columns, filter rows, order and limit them. Returns columns and rows (cells as text).',
    item: csvItem, contentKind: 'structured-data', fidelity: 'lossy-ok',
    describeActivity: ({ items }) => ({ title: items.length === 1 ? 'Querying CSV' : `Running ${items.length} CSV queries` }),
    runItem: async ({ csv, header = true, select, where = [], orderBy, limit = DEFAULT_ROWS }) => {
      const records = guarded(() => parseCsv({ text: csv }));
      const width = Math.max(0, ...records.map(record => record.length));
      const columns = header ? records[0] ?? [] : Array.from({ length: width }, (_unused, index) => `column${index + 1}`);
      const body = (header ? records.slice(1) : records).map(record => [...record, ...Array<string>(Math.max(0, columns.length - record.length)).fill('')]);
      const indexOf = (column: string): number => {
        const index = columns.indexOf(column);
        if (index === -1) throw toolFailure({ code: 'unknown_column', message: `No column '${column}'`, suggestion: `Columns: ${columns.join(', ')}` });
        return index;
      };
      const filters = where.map(condition => ({ condition, index: indexOf(condition.column) }));
      const matched = body.filter(row => filters.every(({ condition, index }) => holds({ cell: row[index] ?? '', condition })));
      if (orderBy != null) {
        const index = indexOf(orderBy.column);
        const sign = orderBy.direction === 'desc' ? -1 : 1;
        matched.sort((first, second) => sign * order(first[index] ?? '', second[index] ?? ''));
      }
      const picked = (select ?? columns).map(column => ({ column, index: indexOf(column) }));
      const rows = matched.slice(0, limit).map(row => picked.map(({ index }) => row[index] ?? ''));
      return { columns: picked.map(({ column }) => column), rows, totalRows: body.length, matchedRows: matched.length, truncated: matched.length > rows.length };
    },
  });
}
