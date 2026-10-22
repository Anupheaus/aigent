import type { PlantContext } from './plant-context.js';
import { REPO_SIZES } from './repo-types.js';
import { compiledJs, cssFile, jsonFixture, markdownDoc } from './file-templates/assets.js';
import { featureIndex, modelModule, serviceModule, serviceTest, storeModule } from './file-templates/ts.js';
import { DOMAIN_WORDS, NEUTRAL_WORDS, pascal } from './vocabulary.js';

/** Files each filler feature contributes (8 sources and docs, 2 compiled copies under `dist/`). */
export const FILES_PER_FEATURE = 10;
const MIN_FEATURES = 3;
const STATUSES: readonly [string, string][] = [['open', 'closed'], ['draft', 'sent'], ['active', 'archived'], ['pending', 'settled']];

/** One filler feature: a small model/store/service module with its test, styles, docs, fixtures and build output. */
function plantFeature(params: { ctx: PlantContext; domain: string; dirName: string; key: string }): void {
  const { ctx, domain, dirName, key } = params;
  const dir = `src/features/${dirName}`;
  const entity = pascal(domain);
  const statuses = ctx.prng.pick(STATUSES);
  const model = `${domain}.model`;
  const store = `${domain}.store`;
  const service = `${domain}.service`;
  const serviceSource = serviceModule({ entity, key, model, store });
  const indexSource = featureIndex({ entity, key, model, service });
  ctx.add({ path: `${dir}/${model}.ts`, content: modelModule({ entity, statuses, constName: key.toUpperCase() }) });
  ctx.add({ path: `${dir}/${store}.ts`, content: storeModule({ entity, key, model }) });
  ctx.add({ path: `${dir}/${service}.ts`, content: serviceSource });
  ctx.add({ path: `${dir}/index.ts`, content: indexSource });
  ctx.add({ path: `${dir}/${service}.test.ts`, content: serviceTest({ key, service, label: `${dirName} service`, status: statuses[0] }) });
  ctx.add({ path: `${dir}/styles.css`, content: cssFile({ selector: dirName, gap: ctx.prng.int({ min: 2, max: 6 }) * 4 }) });
  ctx.add({ path: `${dir}/README.md`, content: markdownDoc({ title: `${entity} (${dirName})`, paragraphs: [`Keeps ${domain} records for the ${dirName} workspace.`, 'Records are created by the service and totalled for reports.'] }) });
  ctx.add({ path: `${dir}/fixtures.json`, content: jsonFixture({ prefix: dirName, count: ctx.prng.int({ min: 2, max: 4 }) }) });
  ctx.add({ path: `dist/features/${dirName}/${service}.js`, content: compiledJs({ source: serviceSource }) });
  ctx.add({ path: `dist/features/${dirName}/index.js`, content: compiledJs({ source: indexSource }) });
}

/** Unique feature directory names: domain-neutral pairs, numbered once every pair is taken. */
function featureNames(params: { ctx: PlantContext; count: number }): { domain: string; dirName: string; key: string }[] {
  const { ctx, count } = params;
  const pairs = ctx.prng.shuffle(DOMAIN_WORDS.flatMap(domain => NEUTRAL_WORDS.map(neutral => ({ domain, neutral }))));
  return Array.from({ length: count }, (_unused, position) => {
    const pair = pairs[position % pairs.length] ?? { domain: 'order', neutral: 'oak' };
    const round = Math.floor(position / pairs.length);
    const suffix = round === 0 ? '' : String(round + 1);
    return { domain: pair.domain, dirName: `${pair.domain}-${pair.neutral}${suffix}`, key: `${pascal(pair.domain)}${pascal(pair.neutral)}${suffix}` };
  });
}

/** Fills the repository with filler features up to (about) the size's file count; returns how many were planted. */
export function plantFiller(params: { ctx: PlantContext; existingFiles: number }): number {
  const { ctx, existingFiles } = params;
  const count = Math.max(MIN_FEATURES, Math.round((REPO_SIZES[ctx.size] - existingFiles) / FILES_PER_FEATURE));
  for (const feature of featureNames({ ctx, count })) plantFeature({ ctx, ...feature });
  return count;
}
