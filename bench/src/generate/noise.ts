import type { PlantContext } from './plant-context.js';
import { htmlPage, lockfile, markdownDoc, minifiedBundle, yamlConfig } from './file-templates/assets.js';
import { lines } from './file-templates/text.js';

const LOCK_PACKAGES = ['react', 'react-dom', 'zod', 'vitest', 'typescript', 'date-fns', 'lodash', 'left-pad', 'chalk', 'commander', 'debug', 'ms', 'semver', 'uuid', 'yaml'];
const VENDOR_LIBRARIES = ['chartkit', 'datekit', 'gridkit'];
const MINIFIED_FILLER = 120;

/** Lockfiles, vendored minified bundles, installed packages and build configs: material every search should skip. */
export function plantNoise(ctx: PlantContext): void {
  ctx.add({ path: 'package-lock.json', content: lockfile({ name: 'storefront', packages: LOCK_PACKAGES }), item: { kind: 'noise', reason: 'npm lockfile' } });
  for (const library of VENDOR_LIBRARIES) {
    ctx.add({ path: `vendor/${library}.min.js`, content: minifiedBundle({ library, names: [`${library}Init`], filler: MINIFIED_FILLER }), item: { kind: 'noise', reason: 'vendored minified bundle' } });
  }
  ctx.add({ path: 'node_modules/left-pad/index.js', content: lines('module.exports = function leftPad(text, length) {', "  return String(text).padStart(length, ' ');", '};'), item: { kind: 'noise', reason: 'installed dependency' } });
  ctx.add({ path: 'node_modules/left-pad/package.json', content: lines('{ "name": "left-pad", "version": "1.0.0", "main": "index.js" }') });
  ctx.add({ path: 'dist/index.js', content: lines('"use strict";', '/* compiled output, do not edit */', 'export {};'), item: { kind: 'noise', reason: 'build output' } });
}

/** The repository shell: package metadata, configs, docs and the HTML entry. */
export function plantShell(ctx: PlantContext): void {
  ctx.add({ path: 'package.json', content: `${JSON.stringify({ name: 'storefront', private: true, type: 'module', scripts: { build: 'tsc -p .', test: 'vitest run' } }, null, 2)}\n` });
  ctx.add({ path: 'tsconfig.json', content: `${JSON.stringify({ compilerOptions: { strict: true, jsx: 'react-jsx', module: 'NodeNext' }, include: ['src'] }, null, 2)}\n` });
  ctx.add({ path: '.gitignore', content: lines('node_modules/', 'dist/', 'coverage/') });
  ctx.add({ path: 'README.md', content: markdownDoc({ title: 'Storefront', paragraphs: ['The storefront web app and its HTTP API.', 'Run `npm test` before opening a pull request.'] }) });
  ctx.add({ path: 'docs/architecture.md', content: markdownDoc({ title: 'Architecture', paragraphs: ['The web app renders pages; the HTTP API serves data.', 'Filler records are kept in memory during tests.'] }) });
  ctx.add({ path: 'public/index.html', content: htmlPage({ title: 'Storefront', body: ['<div id="root"></div>', '<script type="module" src="/src/app/main.tsx"></script>'] }) });
  ctx.add({ path: 'config/app.yaml', content: yamlConfig({ name: 'storefront', entries: { port: 8080, workers: 2 } }) });
  ctx.add({ path: '.github/workflows/ci.yml', content: lines('name: CI', 'on: [push]', 'jobs:', '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm ci', '      - run: npm test') });
  ctx.add({
    path: 'src/server/http.ts',
    content: lines(
      'export interface ApiRequest {',
      '  params: Record<string, string>;',
      '  body: unknown;',
      '}',
      '',
      'export interface ApiResponse {',
      '  status: number;',
      '  body: unknown;',
      '}',
      '',
      'export type ApiHandler = (request: ApiRequest) => Promise<ApiResponse>;',
      '',
      'export function createRouter() {',
      '  const routes: { method: string; path: string; handler: ApiHandler }[] = [];',
      '  const add = (method: string) => (path: string, handler: ApiHandler) => { routes.push({ method, path, handler }); };',
      "  return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };",
      '}',
      '',
      'export function createServer() {',
      '  const routers: ReturnType<typeof createRouter>[] = [];',
      '  return { routers, use: (router: ReturnType<typeof createRouter>) => { routers.push(router); } };',
      '}',
    ),
  });
  ctx.add({
    path: 'src/server/db.ts',
    content: lines(
      'export interface Database {',
      '  query(sql: string, params?: unknown[]): Promise<unknown[]>;',
      '}',
      '',
      'export const db: Database = {',
      '  query: async () => [],',
      '};',
    ),
  });
}
