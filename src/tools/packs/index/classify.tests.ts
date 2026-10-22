import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LABELLED_FILES } from './classify-fixtures.test-support.js';
import { buildCard } from './file-cards.js';
import { linkCards } from './index-graph.js';
import { FILE_TAGS } from './index-types.js';

const MIN_PRECISION = 0.95;
const MIN_RECALL = 0.9;

const cards = linkCards(LABELLED_FILES.map(({ path, text }) => buildCard({ path, text, size: text.length, hash: createHash('sha256').update(text).digest('hex') }))).files;

describe('file classification against hand-labelled fixtures', () => {
  it.each(FILE_TAGS.filter(tag => LABELLED_FILES.some(({ tags }) => tags.includes(tag))))(`%s: precision >= ${MIN_PRECISION}, recall >= ${MIN_RECALL}`, tag => {
    const expected = new Set(LABELLED_FILES.filter(({ tags }) => tags.includes(tag)).map(({ path }) => path));
    const predicted = new Set([...cards.values()].filter(({ tags }) => tags.includes(tag)).map(({ path }) => path));
    const truePositives = [...predicted].filter(path => expected.has(path)).length;
    expect(predicted.size === 0 ? 0 : truePositives / predicted.size, `${tag} precision: ${[...predicted].join(', ')}`).toBeGreaterThanOrEqual(MIN_PRECISION);
    expect(truePositives / expected.size, `${tag} recall: ${[...expected].join(', ')}`).toBeGreaterThanOrEqual(MIN_RECALL);
  });

  it('gives exactly the labelled tags to every fixture', () => {
    for (const { path, tags } of LABELLED_FILES) expect(cards.get(path)?.tags, path).toEqual([...tags].sort());
  });

  it('reads cards: exports, functions, imports, routes and mounts from code only', () => {
    const routes = cards.get('src/api/routes.ts');
    expect(routes?.routes).toEqual([{ router: 'router', method: 'GET', path: '/users/:id', handler: 'getUser' }, { router: 'router', method: 'DELETE', path: '/users/:id', handler: 'deleteAccount' }]);
    expect(routes?.imports.find(({ specifier }) => specifier === './users')).toMatchObject({ names: ['getUser', 'deleteAccount'], resolved: 'src/api/users.ts' });
    expect(cards.get('src/api/legacyRoutes.ts')?.routes).toEqual([]);
    expect(cards.get('src/server/app.ts')?.mounts).toEqual(['router']);
    expect(cards.get('src/util/math.ts')?.functions).toEqual(['clamp']);
    expect(cards.get('src/styles/index.ts')).toMatchObject({ exports: ['theme'] });
    expect(cards.get('src/styles/theme.ts')?.importers).toEqual(['src/styles/index.ts']);
    expect(cards.get('README.md')).toMatchObject({ language: 'md', purpose: 'App', identifiers: [] });
  });
});
