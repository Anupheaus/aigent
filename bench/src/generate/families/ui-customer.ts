import type { PlantContext } from '../plant-context.js';
import { lines } from '../file-templates/text.js';
import { componentFile, componentTest } from '../file-templates/tsx.js';
import { relativeImport } from '../paths.js';
import { NAME_SUFFIXES, pascal } from '../vocabulary.js';

const QUERY = 'ui-customer';
/** What each personal-data component shows (one expression per line of JSX). */
const PII_VIEWS: readonly string[][] = [
  ['      <dt>Email</dt>', '      <dd>{person.email}</dd>'],
  ['      <dt>Phone</dt>', '      <dd>{person.phone}</dd>'],
  ['      <h3>{person.fullName}</h3>', '      <p>{person.email}</p>'],
  ['      <address>{formatPostal(person.address)}</address>'],
  ['      <span>{person.dateOfBirth}</span>'],
];

/**
 * UI that shows customer personal data (name, email, phone, address, date of birth) against UI that shows none,
 * UI that only keys by customer id, a name-formatting utility, a test and a story.
 */
export function plantUiCustomer(ctx: PlantContext): void {
  const typeDir = `src/ui/${ctx.freshWord()}`;
  const typeFile = `${typeDir}/person.ts`;
  ctx.add({
    path: typeFile,
    content: lines('export interface Person {', '  id: string;', '  fullName: string;', '  email: string;', '  phone: string;', '  address: string;', '  dateOfBirth: string;', '}', '', 'export function formatPostal(address: string): string {', "  return address.split(',').map(part => part.trim()).join('\\n');", '}'),
    item: { kind: 'decoy', reason: 'type and formatter, not UI', decoyFor: [QUERY], answers: ['pii-fields'] },
  });
  ctx.publicExport({ names: ['formatPostal'], file: typeFile });
  const count = ctx.prng.int({ min: 3, max: PII_VIEWS.length });
  for (const [position, view] of ctx.prng.shuffle(PII_VIEWS).slice(0, count).entries()) {
    const word = ctx.freshWord();
    const name = `${pascal(word)}${ctx.prng.pick(NAME_SUFFIXES)}`;
    const path = `src/ui/${word}/${name}.tsx`;
    const imports = [`import type { Person } from '${relativeImport({ from: path, to: typeFile })}';`, ...(view.some(line => line.includes('formatPostal')) ? [`import { formatPostal } from '${relativeImport({ from: path, to: typeFile })}';`] : [])];
    ctx.add({ path, content: componentFile({ name, props: ['person: Person'], imports, style: position % 2 === 0 ? 'function' : 'arrow', body: ['    <dl className="person">', ...view, '    </dl>'] }), item: { kind: 'needle', reason: 'renders customer personal data', answers: [QUERY, 'react'] } });
    ctx.publicExport({ names: [name], file: path });
  }
  const totals = `${pascal(ctx.freshWord())}Totals`;
  ctx.add({ path: `src/ui/${totals}.tsx`, content: componentFile({ name: totals, props: ['amount: number'], body: ['    <p className="total">{amount.toFixed(2)}</p>'] }), item: { kind: 'decoy', reason: 'UI without personal data', decoyFor: [QUERY], answers: ['react'] } });
  ctx.publicExport({ names: [totals], file: `src/ui/${totals}.tsx` });
  const listWord = ctx.freshWord();
  const list = `${pascal(listWord)}List`;
  const listPath = `src/ui/${listWord}/${list}.tsx`;
  ctx.add({
    path: listPath,
    content: componentFile({ name: list, props: ['people: Person[]', 'labels: Record<string, string>'], imports: [`import type { Person } from '${relativeImport({ from: listPath, to: typeFile })}';`], body: ['    <ul>', '      {people.map(person => <li key={person.id}>{labels[person.id]}</li>)}', '    </ul>'] }),
    item: { kind: 'decoy', reason: 'keys by customer id, shows no personal data', decoyFor: [QUERY], answers: ['react'] },
  });
  ctx.publicExport({ names: [list], file: listPath });
  const formatterPath = `src/lib/${ctx.freshWord()}/formatCustomerName.ts`;
  ctx.add({ path: formatterPath, content: lines('export function formatCustomerName(first: string, last: string): string {', '  return `${last.toUpperCase()}, ${first}`;', '}'), item: { kind: 'decoy', reason: 'formats names, renders nothing', decoyFor: [QUERY] } });
  ctx.publicExport({ names: ['formatCustomerName'], file: formatterPath });
  ctx.add({ path: `${typeDir}/person.test.tsx`, content: componentTest({ name: list, module: relativeImport({ from: `${typeDir}/person.test.tsx`, to: listPath }).replace(/^\.\//, ''), args: "people={[{ id: '1', fullName: 'Ada', email: 'ada@example.com', phone: '1', address: 'x', dateOfBirth: '1990-01-01' }]} labels={{}}" }), item: { kind: 'decoy', reason: 'test rendering customer data', decoyFor: [QUERY] } });
}
