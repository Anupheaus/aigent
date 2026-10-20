import type { Tool } from '../../tool-types.js';
import { createFsDelete } from './fs-delete.js';
import { createFsEdit } from './fs-edit.js';
import { createFsList } from './fs-list.js';
import { createFsMove } from './fs-move.js';
import { createFsRead } from './fs-read.js';
import { createFsSearch } from './fs-search.js';
import { resolveDeps } from './fs-shared.js';
import type { FsToolsOptions } from './fs-shared.js';
import { createFsStat } from './fs-stat.js';
import { createFsWrite } from './fs-write.js';

/**
 * The filesystem pack: `fs_read`, `fs_list`, `fs_search`, `fs_stat`, `fs_write`, `fs_edit`, `fs_move` and
 * `fs_delete`, every path going through `options.policy` (deny by default) and the disk through `options.access`.
 */
export function fsTools(options: FsToolsOptions): Tool[] {
  const deps = resolveDeps(options);
  return [createFsRead(deps), createFsList(deps), createFsSearch(deps), createFsStat(deps), createFsWrite(deps), createFsEdit(deps), createFsMove(deps), createFsDelete(deps)];
}
