import { pascal } from '../vocabulary.js';
import { lines } from './text.js';

/** A filler record model: no personal-data fields, no planted identifiers. */
export function modelModule(params: { entity: string; statuses: [string, string]; constName: string }): string {
  const { entity, statuses: [first, second], constName } = params;
  return lines(
    `export interface ${entity}Record {`,
    '  id: string;',
    '  reference: string;',
    '  amount: number;',
    `  status: '${first}' | '${second}';`,
    '  createdAt: string;',
    '}',
    '',
    `export const ${constName}_STATUSES = ['${first}', '${second}'] as const;`,
  );
}

export function storeModule(params: { entity: string; key: string; model: string }): string {
  const { entity, key, model } = params;
  return lines(
    `import type { ${entity}Record } from './${model}';`,
    '',
    `const records = new Map<string, ${entity}Record>();`,
    '',
    `export function save${key}(record: ${entity}Record): void {`,
    '  records.set(record.id, record);',
    '}',
    '',
    `export function find${key}(id: string): ${entity}Record | undefined {`,
    '  return records.get(id);',
    '}',
  );
}

export function serviceModule(params: { entity: string; key: string; model: string; store: string }): string {
  const { entity, key, model, store } = params;
  return lines(
    `import type { ${entity}Record } from './${model}';`,
    `import { find${key}, save${key} } from './${store}';`,
    '',
    `export function create${key}(input: Omit<${entity}Record, 'createdAt'>): ${entity}Record {`,
    `  const record = { ...input, createdAt: '2024-01-01T00:00:00.000Z' };`,
    `  save${key}(record);`,
    '  return record;',
    '}',
    '',
    `export function total${key}(records: ${entity}Record[]): number {`,
    '  return records.reduce((sum, record) => sum + record.amount, 0);',
    '}',
    '',
    `export function describe${key}(id: string): string {`,
    `  const record = find${key}(id);`,
    "  return record === undefined ? 'missing' : `${record.reference} (${record.status})`;",
    '}',
  );
}

export function featureIndex(params: { entity: string; key: string; model: string; service: string }): string {
  const { entity, key, model, service } = params;
  return lines(
    `export { create${key}, describe${key}, total${key} } from './${service}';`,
    `export type { ${entity}Record } from './${model}';`,
  );
}

export function serviceTest(params: { key: string; service: string; label: string; status: string }): string {
  const { key, service, label, status } = params;
  return lines(
    "import { describe, expect, it } from 'vitest';",
    `import { create${key}, total${key} } from './${service}';`,
    '',
    `describe('${label}', () => {`,
    "  it('totals amounts', () => {",
    `    const record = create${key}({ id: 'a1', reference: 'R-1', amount: 5, status: '${status}' });`,
    `    expect(total${key}([record])).toBe(5);`,
    '  });',
    '});',
  );
}

/** A small utility module named `stem`, exporting `build<Stem>` (planters register it as a public export so it is used). */
export function utilityModule(params: { stem: string }): string {
  const { stem } = params;
  const pascalStem = pascal(stem);
  const type = `${pascalStem}Entry`;
  return lines(
    `export interface ${type} {`,
    '  key: string;',
    '  weight: number;',
    '}',
    '',
    `export function build${pascalStem}(entries: ${type}[]): Map<string, number> {`,
    '  const totals = new Map<string, number>();',
    '  for (const entry of entries) totals.set(entry.key, (totals.get(entry.key) ?? 0) + entry.weight);',
    '  return totals;',
    '}',
  );
}

/** A small exported helper module: `names` are the exported functions, each returning a distinct constant. */
export function helperModule(params: { names: string[]; header?: string[] }): string {
  const { names, header = [] } = params;
  return lines(header, names.flatMap((name, position) => [
    ...(position === 0 ? [] : ['']),
    `export function ${name}(value: number): number {`,
    `  return value * ${position + 2};`,
    '}',
  ]));
}
