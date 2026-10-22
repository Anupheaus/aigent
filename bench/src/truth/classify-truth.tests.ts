import { describe, expect, it } from 'vitest';
import type { RepoTree } from '../generate/repo-types.js';
import { liveEndpoints, traceRoute } from './api-truth.js';
import { customerDataUi, piiDeclarations, privacyHandlers, reactComponents, testsOf, themeDefinitions } from './classify-truth.js';
import { deadExports } from './export-truth.js';

const tree = (files: Record<string, string>): RepoTree => new Map(Object.entries(files));

describe('classification truth (hand-built repositories)', () => {
  it('finds React components, not stories, mocks, tests, hooks, HOCs or markup strings', () => {
    const repo = tree({
      'src/A.tsx': 'export function A() {\n  return (\n    <div />\n  );\n}',
      'src/B.tsx': 'export const B = ({ x }: P) => (\n  <p>{x}</p>\n);',
      'src/A.stories.tsx': 'export const Primary = () => <A />;',
      'src/__mocks__/A.tsx': 'export const A = () => <div />;',
      'src/A.test.tsx': 'export function T() { return <A />; }',
      'src/withX.tsx': 'export function withX(W) {\n  return function WithX(p) {\n    return <W {...p} />;\n  };\n}',
      'src/Markup.tsx': "export function Markup(label: string): string {\n  return '<div>' + label + '</div>';\n}",
      'src/useX.ts': 'export function useX() { return 1; }',
    });
    expect(reactComponents(repo)).toEqual(['src/A.tsx', 'src/B.tsx']);
  });

  it('finds UI showing personal data, and declarations of personal-data fields', () => {
    const repo = tree({
      'src/Card.tsx': 'export function Card({ person }: P) {\n  return (\n    <dd>{person.email}</dd>\n  );\n}',
      'src/List.tsx': 'export function List({ people }: P) {\n  return (\n    <ul>{people.map(person => <li key={person.id} />)}</ul>\n  );\n}',
      'src/model.ts': 'export interface P {\n  email: string;\n  emailTemplateId: string;\n}',
      'src/draft.ts': 'export interface D {\n  // phone: string;\n  id: string;\n}',
      'src/schema.ts': 'export const s = z.object({\n  dateOfBirth: z.string(),\n});',
    });
    expect(customerDataUi(repo)).toEqual(['src/Card.tsx']);
    expect(piiDeclarations(repo)).toEqual(['src/model.ts', 'src/schema.ts']);
  });

  it('finds privacy handlers, not the service, TODO-only handlers or tests', () => {
    const repo = tree({
      'src/h1.ts': 'export async function h1(request: ApiRequest) {\n  await eraseSubject(request.params.id);\n}',
      'src/h2.ts': '// TODO(GDPR): retention?\nexport async function h2(request: ApiRequest) {\n  return 1;\n}',
      'src/ops.ts': 'export async function eraseSubject(id: string) {}',
      'src/h1.test.ts': 'export async function t(request: ApiRequest) { await eraseSubject("1"); }',
    });
    expect(privacyHandlers(repo)).toEqual(['src/h1.ts']);
  });

  it('finds theme definitions reachable from the entry only', () => {
    const repo = tree({
      'src/main.tsx': "import { App } from './App';",
      'src/App.tsx': "import { look } from './theme';",
      'src/theme/index.ts': "export { look } from './look';",
      'src/theme/look.ts': "import { createTheme } from 'x';\nimport { colours } from './colours';\nexport const look = createTheme({ colours });",
      'src/theme/colours.ts': "export const colours: PaletteTokens = { primary: '#000' };",
      'src/theme/old.ts': "import { createTheme } from 'x';\nexport const old = createTheme({});",
    });
    expect(themeDefinitions({ tree: repo, entry: 'src/main.tsx' })).toEqual(['src/theme/colours.ts', 'src/theme/look.ts']);
  });

  it('finds tests by what they import', () => {
    const repo = tree({ 'src/a.ts': '', 'src/a.test.ts': "import { x } from './a';", 'src/__tests__/a.spec.ts': "import { x } from '../a';", 'src/b/a.test.ts': "import { x } from './a-legacy';", 'src/b/a-legacy.ts': '' });
    expect(testsOf({ tree: repo, module: 'src/a.ts' })).toEqual(['src/__tests__/a.spec.ts', 'src/a.test.ts']);
  });

  it('finds live endpoints and traces one through handler to query', () => {
    const repo = tree({
      'src/app.ts': "import { r } from './r';\nserver.use(r);",
      'src/r.ts': "import { getA } from './h';\nexport const r = createRouter();\nr.get('/api/a', getA);\n// r.delete('/api/a', getA);",
      'src/old.ts': "export const old = createRouter();\nold.get('/api/old', x);",
      'src/h.ts': "import { loadA } from './repo';\nexport async function getA() { return loadA(); }",
      'src/repo.ts': "export async function loadA() { return db.query('SELECT 1'); }",
    });
    expect(liveEndpoints(repo)).toEqual(['GET /api/a']);
    expect(traceRoute({ tree: repo, endpoint: 'GET /api/a' })).toEqual(['src/h.ts', 'src/r.ts', 'src/repo.ts']);
  });

  it('resolves a mounted router through the mounting file\'s imports: a same-named unmounted router stays dead, path mounts prefix', () => {
    const repo = tree({
      'src/app.ts': "import { r as live } from './live';\nserver.use('/v1', live);",
      'src/live.ts': "export const r = createRouter();\nr.get('/a', h);",
      'src/legacy.ts': "export const r = createRouter();\nr.get('/legacy', h);",
      'src/local.ts': "export const own = createRouter();\nown.get('/own', h);\nserver.use(own);",
    });
    expect(liveEndpoints(repo)).toEqual(['GET /own', 'GET /v1/a']);
  });

  it('a same-named local function elsewhere does not keep a dead export alive; namespace, alias and star uses do', () => {
    const repo = tree({
      'src/a.ts': 'export function formatName(x: string) { return x; }\nexport function shared() { return 1; }',
      'src/b.ts': 'function formatName(y: number) { return String(y); }\nexport function main() { return formatName(1); }',
      'src/c.ts': "import { main } from './b';\nimport { shared as aliased } from './a';\nmain();\naliased();",
      'src/d.ts': 'export function viaNamespace() { return 1; }\nexport function notViaNamespace() { return 2; }',
      'src/e.ts': "import * as d from './d';\nd.viaNamespace();",
      'src/f.ts': 'export function starred() { return 1; }',
      'src/barrel.ts': "export * from './f';",
    });
    expect(deadExports(repo)).toEqual(['formatName', 'notViaNamespace']);
  });

  it('finds exports nobody else references (comments and longer names do not count)', () => {
    const repo = tree({
      'src/h.ts': 'export function used() {}\nexport function dead() {}\nexport const deadArrow = () => 1;\nexport function viaTest() {}\nexport function viaDynamic() {}',
      'src/a.ts': "import { used } from './h';\n// dead is mentioned here\nexport const deadArrowEnabled = true;\nused();",
      'src/h.test.ts': "import { viaTest } from './h';",
      'src/lazy.ts': "const m = await import('./h'); m.viaDynamic();",
      'docs/x.md': 'dead',
    });
    expect(deadExports(repo)).toEqual(['dead', 'deadArrow']);
  });
});
