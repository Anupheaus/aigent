import { z } from 'zod';
import { fsErrorCode } from '../../../security/fs-access.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { allowPath, countTitle, FS_RESULT_HELPERS, MAX_FS_ITEMS, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';

export const FS_STAT_TOOL_NAME = 'fs_stat';

const statItem = z.object({ path: z.string().min(1).describe('Path: absolute, or relative to the workspace root') }).strict();

/** Where a link leads: its target when the policy allows reading it, otherwise only why not (the path stays hidden). */
async function describeLink(params: { deps: FsDeps; path: string }): Promise<Record<string, unknown>> {
  const { deps: { access, policy }, path } = params;
  let target: string;
  try {
    target = await access.realpath(path);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return { linkTarget: null, dangling: true };
    throw error;
  }
  const decision = await policy.check({ path: target, permission: 'read', access });
  return decision.allowed ? { linkTarget: decision.canonicalPath } : { linkTarget: null, linkTargetRefused: decision.code };
}

/** `fs_stat`: whether paths exist, and their type, size and modification time; a link is described, not followed. */
export function createFsStat(deps: FsDeps): Tool {
  const { access } = deps;
  return {
    ...defineBatchTool({
      name: FS_STAT_TOOL_NAME,
      description: 'Check whether paths exist, with their type (file, directory, symlink), size in bytes and modification time. A symlink or junction is described itself, with linkTarget when that is inside the allowed roots.',
      item: statItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, contentKind: 'structured-data', acceptsAliases: true,
      describeActivity: ({ items }) => ({ title: countTitle({ verb: 'Checking', noun: 'paths', paths: items.map(({ path }) => path) }) }),
      runItem: async ({ path }) => {
        const allowed = await allowPath({ deps, path, permission: 'read', followFinalLink: false });
        return onDisk({
          path,
          work: async () => {
            try {
              const { type, size, mtimeMs } = await access.lstat(allowed.path);
              const link = type === 'symlink' ? await describeLink({ deps, path: allowed.path }) : {};
              return { path: allowed.path, exists: true, type, size, mtimeMs, ...link };
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
