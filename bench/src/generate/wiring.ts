import type { PlantContext, PlantState, RouteSpec } from './plant-context.js';
import { relativeImport } from './paths.js';
import { lines } from './file-templates/text.js';

const APP_FILE = 'src/app/App.tsx';
const MAIN_FILE = 'src/app/main.tsx';
const SERVER_APP_FILE = 'src/server/app.ts';
const PUBLIC_INDEX_FILE = 'src/index.ts';

/** `src/server/<group>-router.ts` for a route group. */
export const routerFileOf = (group: string): string => `src/server/${group}-router.ts`;
const routerNameOf = (group: string): string => `${group.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())}Router`;

function writeRouter(params: { ctx: PlantContext; group: string; routes: RouteSpec[] }): void {
  const { ctx, group, routes } = params;
  const file = routerFileOf(group);
  const name = routerNameOf(group);
  const handlers = [...new Map(routes.map(({ handler }) => [handler.name, handler])).values()].sort((first, second) => first.name.localeCompare(second.name));
  ctx.add({
    path: file,
    content: lines(
      "import { createRouter } from './http';",
      handlers.map(handler => `import { ${handler.name} } from '${relativeImport({ from: file, to: handler.file })}';`),
      '',
      `export const ${name} = createRouter();`,
      '',
      routes.map(({ method, path, handler, isCommented = false }) => `${isCommented ? '// ' : ''}${name}.${method.toLowerCase()}('${path}', ${handler.name});`),
    ),
  });
}

function writeServerApp(params: { ctx: PlantContext; groups: string[] }): void {
  const { ctx, groups } = params;
  ctx.add({
    path: SERVER_APP_FILE,
    content: lines(
      "import { createServer } from './http';",
      groups.map(group => `import { ${routerNameOf(group)} } from '${relativeImport({ from: SERVER_APP_FILE, to: routerFileOf(group) })}';`),
      '',
      'export const server = createServer();',
      '',
      groups.map(group => `server.use(${routerNameOf(group)});`),
    ),
  });
}

function writeApp(params: { ctx: PlantContext; state: PlantState }): void {
  const { ctx, state: { slots } } = params;
  const wrappers = slots.filter(({ isWrapper = false }) => isWrapper);
  const leaves = slots.filter(({ isWrapper = false }) => !isWrapper);
  const depth = wrappers.length;
  const pad = (level: number): string => '  '.repeat(level + 2);
  const body = [
    ...wrappers.map((wrapper, level) => `${pad(level)}<${wrapper.name}>`),
    `${pad(depth)}<main className="app">`,
    ...leaves.map(leaf => `${pad(depth + 1)}<${leaf.name} />`),
    `${pad(depth)}</main>`,
    ...[...wrappers].reverse().map((wrapper, position) => `${pad(depth - position - 1)}</${wrapper.name}>`),
  ];
  ctx.add({
    path: APP_FILE,
    content: lines(slots.map(slot => `import { ${slot.name} } from '${relativeImport({ from: APP_FILE, to: slot.file })}';`), ...(slots.length === 0 ? [] : ['']), 'export function App() {', '  return (', body, '  );', '}'),
    item: { kind: 'needle', reason: 'the app shell component', answers: ['react'] },
  });
  ctx.add({ path: MAIN_FILE, content: lines("import { createRoot } from 'react-dom/client';", "import { App } from './App';", '', "createRoot(document.getElementById('root') as HTMLElement).render(<App />);") });
}

function writePublicIndex(params: { ctx: PlantContext; state: PlantState }): void {
  const { ctx, state: { publicExports } } = params;
  const sorted = [...publicExports].sort((first, second) => first.file.localeCompare(second.file));
  ctx.add({ path: PUBLIC_INDEX_FILE, content: lines(sorted.map(({ names, file }) => `export { ${[...names].sort().join(', ')} } from '${relativeImport({ from: PUBLIC_INDEX_FILE, to: file })}';`)) });
}

/** Writes what depends on every family: the app shell, the routers and server, and the public barrel. */
export function writeWiring(params: { ctx: PlantContext; state: PlantState }): void {
  const { ctx, state } = params;
  const groups = [...new Set(state.routes.map(({ group }) => group))].sort();
  for (const group of groups) writeRouter({ ctx, group, routes: state.routes.filter(route => route.group === group) });
  writeServerApp({ ctx, groups });
  writeApp({ ctx, state });
  writePublicIndex({ ctx, state });
}
