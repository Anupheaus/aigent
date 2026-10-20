import { createAigentError } from '../../../core/aigent-error.js';
import { comparable, separatorOf } from '../../../security/path-flavour.js';
import type { Tool } from '../../tool-types.js';
import { createFsDelete } from './fs-delete.js';
import { createFsEdit } from './fs-edit.js';
import { createFsList } from './fs-list.js';
import { createFsMove } from './fs-move.js';
import { createFsRead } from './fs-read.js';
import { createFsSearch } from './fs-search.js';
import { resolveDeps } from './fs-shared.js';
import type { FsDeps, FsToolsOptions } from './fs-shared.js';
import { createFsStat } from './fs-stat.js';
import { createFsWrite } from './fs-write.js';

/** Backups and the trash hold prior contents: inside a root, the agent could read them or tamper with what undo restores. */
function assertBackupDirOutsideRoots(deps: FsDeps): void {
  const { backupDir, policy, access } = deps;
  if (backupDir == null) return;
  const caseSensitive = policy.caseSensitive(access);
  const separator = separatorOf(access.platform);
  const backup = policy.lexical({ path: backupDir, access });
  if (!backup.ok) throw createAigentError({ code: 'invalid_definition', message: `fsTools: backupDir '${backupDir}' is not a usable path: ${backup.message}`, details: { option: 'backupDir' } });
  const backupPath = comparable({ path: backup.path, caseSensitive });
  for (const root of policy.roots) {
    const lexical = policy.lexical({ path: root.path, access });
    if (!lexical.ok) continue;
    const rootPath = comparable({ path: lexical.path, caseSensitive });
    if (backupPath === rootPath || backupPath.startsWith(rootPath.endsWith(separator) ? rootPath : rootPath + separator)) {
      throw createAigentError({ code: 'invalid_definition', message: `fsTools: backupDir '${backupDir}' is inside the allowed root '${root.label ?? root.path}'; put it outside every root`, details: { option: 'backupDir' } });
    }
  }
}

/**
 * The filesystem pack: `fs_read`, `fs_list`, `fs_search`, `fs_stat`, `fs_write`, `fs_edit`, `fs_move` and
 * `fs_delete`, every path going through `options.policy` (deny by default) and the disk through `options.access`.
 */
export function fsTools(options: FsToolsOptions): Tool[] {
  const deps = resolveDeps(options);
  assertBackupDirOutsideRoots(deps);
  return [createFsRead(deps), createFsList(deps), createFsSearch(deps), createFsStat(deps), createFsWrite(deps), createFsEdit(deps), createFsMove(deps), createFsDelete(deps)];
}
