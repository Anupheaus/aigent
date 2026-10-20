import { z } from 'zod';
import { fsErrorCode } from '../../../security/fs-access.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { allowPath, countTitle, FS_RESULT_HELPERS, MAX_FS_ITEMS, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';

export const FS_STAT_TOOL_NAME = 'fs_stat';

const statItem = z.object({ path: z.string().min(1).describe('Path: absolute, or relative to the workspace root') }).strict();

/** `fs_stat`: whether paths exist, and their type, size and modification time. */
export function createFsStat(deps: FsDeps): Tool {
  const { access } = deps;
  return {
    ...defineBatchTool({
      name: FS_STAT_TOOL_NAME,
      description: 'Check whether paths exist, with their type (file, directory, symlink), size in bytes and modification time.',
      item: statItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, contentKind: 'structured-data', acceptsAliases: true,
      describeActivity: ({ items }) => ({ title: countTitle({ verb: 'Checking', noun: 'paths', paths: items.map(({ path }) => path) }) }),
      runItem: async ({ path }) => {
        const allowed = await allowPath({ deps, path, permission: 'read' });
        return onDisk({
          path,
          work: async () => {
            try {
              const { type, size, mtimeMs } = await access.lstat(allowed.path);
              return { path: allowed.path, exists: true, type, size, mtimeMs };
            } catch (error) {
              if (fsErrorCode(error) === 'ENOENT') return { path: allowed.path, exists: false };
              throw error;
            }
          },
        });
      },
    }),
    ...FS_RESULT_HELPERS,
  };
}
