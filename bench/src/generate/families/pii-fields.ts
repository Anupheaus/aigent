import type { PlantContext } from '../plant-context.js';
import { compiledJs, markdownDoc } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { pascal } from '../vocabulary.js';

const QUERY = 'pii-fields';

/** Models and schemas that declare personal-data fields, against near-miss names, a commented field, fixtures and docs. */
export function plantPiiFields(ctx: PlantContext): void {
  const needle = (reason: string) => ({ kind: 'needle' as const, reason, answers: [QUERY] });
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [QUERY] });
  const contact = pascal(ctx.freshWord());
  const contactPath = `src/models/${contact.toLowerCase()}-contact.ts`;
  ctx.add({ path: contactPath, content: lines(`export interface ${contact}Contact {`, '  id: string;', '  firstName: string;', '  lastName: string;', '  phoneNumber?: string;', '}'), item: needle('interface with name and phone fields') });
  const schemaWord = ctx.freshWord();
  const schemaPath = `src/server/schemas/${schemaWord}.ts`;
  ctx.add({ path: schemaPath, content: lines("import { z } from 'zod';", '', `export const ${schemaWord}Schema = z.object({`, '  id: z.string(),', '  email: z.string().email(),', '  dateOfBirth: z.string(),', '  postalAddress: z.string(),', '});'), item: needle('zod schema with email, birth date and address') });
  const nearWord = ctx.freshWord();
  ctx.add({ path: `src/models/${nearWord}-settings.ts`, content: lines(`export interface ${pascal(nearWord)}Settings {`, '  emailTemplateId: string;', '  phoneticKey: string;', '  addressBookEnabled: boolean;', '}'), item: decoy('near-miss field names') });
  const commentedWord = ctx.freshWord();
  ctx.add({ path: `src/models/${commentedWord}-draft.ts`, content: lines(`export interface ${pascal(commentedWord)}Draft {`, '  id: string;', '  // email: string; (removed: collected by the identity service instead)', '}'), item: decoy('field commented out') });
  ctx.add({ path: `src/models/${commentedWord}-draft.fixture.test.ts`, content: lines("import { it } from 'vitest';", '', "it('builds a fixture', () => {", "  const fixture = { id: '1', email: 'someone@example.com', fullName: 'Someone' };", '  void fixture;', '});'), item: decoy('test fixture with personal data') });
  ctx.add({ path: 'docs/personal-data.md', content: markdownDoc({ title: 'Personal data', paragraphs: ['We store fullName, email, phone and address for each customer.'] }), item: decoy('documentation') });
  ctx.add({ path: `dist/models/${contact.toLowerCase()}-contact.js`, content: compiledJs({ source: lines('export const fields = ["firstName", "lastName", "phoneNumber"];') }), item: decoy('build output') });
}
