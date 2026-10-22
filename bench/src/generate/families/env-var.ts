import type { PlantContext } from '../plant-context.js';
import { compiledJs, markdownDoc } from '../file-templates/assets.js';
import { lines } from '../file-templates/text.js';
import { pascal, upperSnake } from '../vocabulary.js';
import { SOURCE_AREAS } from './string-target.js';

const QUERY = 'env-var';
const ENDINGS = ['URL', 'TOKEN_TTL', 'REGION', 'TIMEOUT_MS', 'BUCKET'];

/** An environment variable read by a few source files, against docs, CI config, a longer name, a test and build output. */
export function plantEnvVar(ctx: PlantContext): void {
  const name = `${upperSnake([ctx.freshWord(), ctx.freshWord()])}_${ctx.prng.pick(ENDINGS)}`;
  ctx.term('env-var.name', name);
  const needle = (reason: string) => ({ kind: 'needle' as const, reason, answers: [QUERY], distinctive: [name] });
  const decoy = (reason: string) => ({ kind: 'decoy' as const, reason, decoyFor: [QUERY], distinctive: [name] });
  const configWord = ctx.freshWord();
  const configPath = `src/${ctx.prng.pick(SOURCE_AREAS)}/${configWord}/settings.ts`;
  ctx.add({ path: configPath, content: lines(`export function ${configWord}Endpoint(): string {`, `  return process.env.${name} ?? 'http://localhost:9000';`, '}'), item: needle('reads it with process.env') });
  ctx.publicExport({ names: [`${configWord}Endpoint`], file: configPath });
  const workerWord = ctx.freshWord();
  const workerPath = `src/${ctx.prng.pick(SOURCE_AREAS)}/${workerWord}/${workerWord}-worker.ts`;
  ctx.add({ path: workerPath, content: lines(`export function start${pascal(workerWord)}(): string {`, `  const { ${name} } = process.env;`, `  if (${name} === undefined) return 'disabled';`, `  return ${name};`, '}'), item: needle('destructures it from process.env') });
  ctx.publicExport({ names: [`start${pascal(workerWord)}`], file: workerPath });
  ctx.add({ path: 'scripts/healthcheck.js', content: lines(`const target = process.env.${name};`, "console.log(target === undefined ? 'unset' : 'set');"), item: needle('script reading it') });
  ctx.add({ path: `docs/deploy-${configWord}.md`, content: markdownDoc({ title: 'Deploying', paragraphs: [`Set \`${name}\` before starting the worker.`] }), item: decoy('documentation') });
  ctx.add({ path: '.github/workflows/deploy.yml', content: lines('name: Deploy', 'on: [workflow_dispatch]', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest', '    env:', `      ${name}: \${{ vars.${name} }}`, '    steps:', '      - run: npm run deploy'), item: decoy('CI configuration sets it') });
  const legacyWord = ctx.freshWord();
  const legacyPath = `src/${ctx.prng.pick(SOURCE_AREAS)}/${legacyWord}/${legacyWord}-legacy.ts`;
  ctx.add({ path: legacyPath, content: lines(`// Replaced ${name}; kept until every deployment has moved over.`, `export function legacy${pascal(legacyWord)}(): string | undefined {`, `  return process.env.${name}_LEGACY;`, '}'), item: decoy('reads a longer variable; the name is only in a comment') });
  ctx.publicExport({ names: [`legacy${pascal(legacyWord)}`], file: legacyPath });
  ctx.add({ path: `${workerPath.replace(/\.ts$/, '.test.ts')}`, content: lines("import { expect, it } from 'vitest';", `import { start${pascal(workerWord)} } from './${workerWord}-worker';`, '', "it('reads the variable', () => {", `  process.env.${name} = 'http://test';`, `  expect(start${pascal(workerWord)}()).toBe('http://test');`, '});'), item: decoy('test sets it') });
  ctx.add({ path: `dist/${configWord}/settings.js`, content: compiledJs({ source: lines(`export function ${configWord}Endpoint() {`, `  return process.env.${name};`, '}') }), item: decoy('build output') });
}
