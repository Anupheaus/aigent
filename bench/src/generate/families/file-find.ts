import type { PlantContext } from '../plant-context.js';
import { plantNameDecoys } from '../decoys.js';
import { utilityModule } from '../file-templates/ts.js';
import { camel, pascal } from '../vocabulary.js';

const STEM_SUFFIXES = ['Digest', 'Snapshot', 'Matrix', 'Registry', 'Ledger', 'Rollup'];

/** A stem such as `cedarFalconDigest`: two fresh words and a suffix. */
export function freshStem(ctx: PlantContext): string {
  return camel([ctx.freshWord(), ctx.freshWord(), ctx.prng.pick(STEM_SUFFIXES).toLowerCase()]);
}

/** One file with a distinctive name among thousands, surrounded by look-alikes. */
export function plantFileFind(ctx: PlantContext): void {
  const stem = freshStem(ctx);
  const dir = `src/lib/${ctx.freshWord()}`;
  const path = `${dir}/${stem}.ts`;
  ctx.add({ path, content: utilityModule({ stem }), item: { kind: 'needle', reason: 'the file the user names', answers: ['find-file'] } });
  ctx.publicExport({ names: [`build${pascal(stem)}`], file: path });
  ctx.term('find-file.name', `${stem}.ts`);
  plantNameDecoys({ ctx, stem, dir, query: 'find-file' });
}
