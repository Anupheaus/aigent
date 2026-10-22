import type { PlantContext, RouteSpec } from '../plant-context.js';
import { markdownDoc } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { componentFile } from '../file-templates/tsx.js';
import { relativeImport } from '../paths.js';
import { pascal } from '../vocabulary.js';

const QUERY = 'gdpr';

/** One privacy operation: the service function a handler calls, and the route it is served on. */
interface PrivacyOperation {
  op: string;
  method: RouteSpec['method'];
  verb: string;
  call: string;
}

const OPERATIONS: readonly PrivacyOperation[] = [
  { op: 'recordConsent', method: 'POST', verb: 'grant', call: 'await recordConsent(request.params.id, request.body);' },
  { op: 'withdrawConsent', method: 'DELETE', verb: 'revoke', call: 'await withdrawConsent(request.params.id);' },
  { op: 'eraseSubject', method: 'DELETE', verb: 'erase', call: 'await eraseSubject(request.params.id);' },
  { op: 'exportSubjectData', method: 'GET', verb: 'bundle', call: 'const bundle = await exportSubjectData(request.params.id);' },
  { op: 'purgeExpiredRecords', method: 'POST', verb: 'sweep', call: 'await purgeExpiredRecords(RETENTION_DAYS);' },
];

function handlerSource(params: { name: string; operation: PrivacyOperation; servicePath: string; path: string }): string {
  const { name, operation, servicePath, path } = params;
  const returns = operation.op === 'exportSubjectData' ? 'return { status: 200, body: bundle };' : 'return { status: 204, body: null };';
  return lines(
    `import type { ApiRequest, ApiResponse } from '${relativeImport({ from: path, to: 'src/server/http.ts' })}';`,
    `import { ${operation.op}${operation.op === 'purgeExpiredRecords' ? ', RETENTION_DAYS' : ''} } from '${relativeImport({ from: path, to: servicePath })}';`,
    '',
    `export async function ${name}(request: ApiRequest): Promise<ApiResponse> {`,
    `  ${operation.call}`,
    `  ${returns}`,
    '}',
  );
}

/**
 * Handlers that implement consent, erasure, data export and retention against the privacy service (not a handler),
 * a handler with only a GDPR TODO, privacy copy, an orders CSV "export", docs and a test.
 */
export function plantGdprApi(ctx: PlantContext): void {
  const group = ctx.freshWord();
  const serviceDir = `src/server/${ctx.freshWord()}`;
  const servicePath = `${serviceDir}/subject-ops.ts`;
  ctx.add({
    path: servicePath,
    content: lines(
      "import { db } from '../db';",
      '',
      'export const RETENTION_DAYS = 400;',
      '',
      "export async function recordConsent(id: string, scope: unknown): Promise<void> { await db.query('INSERT INTO consents VALUES ($1, $2)', [id, scope]); }",
      "export async function withdrawConsent(id: string): Promise<void> { await db.query('DELETE FROM consents WHERE subject = $1', [id]); }",
      "export async function eraseSubject(id: string): Promise<void> { await db.query('DELETE FROM subjects WHERE id = $1', [id]); }",
      "export async function exportSubjectData(id: string): Promise<unknown[]> { return db.query('SELECT * FROM subjects WHERE id = $1', [id]); }",
      "export async function purgeExpiredRecords(days: number): Promise<void> { await db.query('DELETE FROM events WHERE age > $1', [days]); }",
    ),
    item: { kind: 'decoy', reason: 'the privacy service the handlers call (not an API handler)', decoyFor: [QUERY] },
  });
  const apiDir = `src/server/api/${ctx.freshWord()}`;
  const routeBase = `/api/${ctx.freshWord()}`;
  for (const operation of OPERATIONS) {
    const name = `${operation.verb}${pascal(ctx.freshWord())}`;
    const path = `${apiDir}/${name}.ts`;
    ctx.add({ path, content: handlerSource({ name, operation, servicePath, path }), item: { kind: 'needle', reason: `implements ${operation.op}`, answers: [QUERY] } });
    ctx.route({ group, method: operation.method, path: `${routeBase}/:id/${operation.verb}`, handler: { name, file: path } });
  }
  const todoName = `list${pascal(ctx.freshWord())}`;
  const todoPath = `${apiDir}/${todoName}.ts`;
  ctx.add({ path: todoPath, content: lines(`import type { ApiRequest, ApiResponse } from '${relativeImport({ from: todoPath, to: 'src/server/http.ts' })}';`, '', '// TODO(GDPR): check whether this listing needs a retention rule.', `export async function ${todoName}(request: ApiRequest): Promise<ApiResponse> {`, '  return { status: 200, body: [request.params.id] };', '}'), item: { kind: 'decoy', reason: 'mentions GDPR only in a TODO', decoyFor: [QUERY] } });
  ctx.route({ group, method: 'GET', path: `${routeBase}/:id`, handler: { name: todoName, file: todoPath } });
  const csvName = `orders${pascal(ctx.freshWord())}Csv`;
  const csvPath = `${apiDir}/${csvName}.ts`;
  ctx.add({ path: csvPath, content: lines(`import type { ApiRequest, ApiResponse } from '${relativeImport({ from: csvPath, to: 'src/server/http.ts' })}';`, '', '/** Exports the order book as CSV for accounting (no personal data). */', `export async function ${csvName}(request: ApiRequest): Promise<ApiResponse> {`, "  return { status: 200, body: ['id,total', String(request.params.id)].join('\\n') };", '}'), item: { kind: 'decoy', reason: 'an export that is not a personal-data export', decoyFor: [QUERY] } });
  ctx.route({ group, method: 'GET', path: `${routeBase}/orders.csv`, handler: { name: csvName, file: csvPath } });
  const noticeWord = ctx.freshWord();
  const notice = `${pascal(noticeWord)}Notice`;
  ctx.add({ path: `src/ui/${noticeWord}/${notice}.tsx`, content: componentFile({ name: notice, props: [], body: ['    <p>We respect your privacy and GDPR rights. Ask us to erase or export your data.</p>'] }), item: { kind: 'decoy', reason: 'privacy copy in the UI', decoyFor: [QUERY], answers: ['react'] } });
  ctx.publicExport({ names: [notice], file: `src/ui/${noticeWord}/${notice}.tsx` });
  ctx.add({ path: 'docs/gdpr.md', content: markdownDoc({ title: 'GDPR', paragraphs: ['Consent, erasure, export and retention requests are served by the HTTP API.', 'Retention is 400 days.'] }), item: { kind: 'decoy', reason: 'documentation', decoyFor: [QUERY] } });
  ctx.add({ path: `${apiDir}/privacy.test.ts`, content: lines("import { expect, it } from 'vitest';", `import { eraseSubject } from '${relativeImport({ from: `${apiDir}/privacy.test.ts`, to: servicePath })}';`, '', "it('erases', async () => {", "  await expect(eraseSubject('1')).resolves.toBeUndefined();", '});'), item: { kind: 'decoy', reason: 'test of the erasure operation', decoyFor: [QUERY] } });
}
