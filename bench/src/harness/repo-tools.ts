import type { Tool } from '../../../src/index.js';
import { createFsPolicy, fsTools } from '../../../src/tools/packs/fs/index.js';
import type { FsAccess } from '../../../src/tools/packs/fs/index.js';
import type { GeneratedRepo } from '../generate/repo-types.js';
import type { TrapSetup } from '../task-spec.js';
import { withFailingReads, withMutatingReads } from './trap-access.js';

/** The Round-0 tool set: the plain filesystem tools, no index. */
export const ROUND_0_TOOLS = ['fs_list', 'fs_read', 'fs_search'] as const;

/** The policy's default deny globs (kept when a trap adds its own, since given globs replace the defaults). */
const DEFAULT_DENY_GLOBS = ['.git/**', '**/.env', '**/.env.*', '**/*.pem', '**/*.key'];

/** A tool-set builder: the tools a round offers over a repository's access and policy. */
export type ToolSetBuilder = (params: { repo: GeneratedRepo; access: FsAccess; policy: ReturnType<typeof createFsPolicy> }) => Tool[];

export const round0Tools: ToolSetBuilder = ({ access, policy }) => fsTools({ policy, access, approvals: 'none' }).filter(tool => (ROUND_0_TOOLS as readonly string[]).includes(tool.name));

/** The access a task's tools use: the repository's, with the trap's injected failures or mutations. */
export function trapAccess(params: { repo: GeneratedRepo; trap?: TrapSetup }): FsAccess {
  const { repo, trap = {} } = params;
  let access = repo.access;
  if (trap.failPath != null) access = withFailingReads({ access, path: `${repo.root}/${trap.failPath}` });
  if (trap.mutatePath != null) access = withMutatingReads({ access, path: `${repo.root}/${trap.mutatePath}` });
  return access;
}

/** Read-only tools over the repository (the root is the only root), under the trap's conditions. */
export function repoTools(params: { repo: GeneratedRepo; trap?: TrapSetup; build?: ToolSetBuilder }): Tool[] {
  const { repo, trap = {}, build = round0Tools } = params;
  const access = trapAccess({ repo, trap });
  const policy = createFsPolicy({ roots: [{ path: repo.root, permissions: ['read'], label: 'repository' }], ...(trap.denyGlobs == null ? {} : { denyGlobs: [...DEFAULT_DENY_GLOBS, ...trap.denyGlobs] }) });
  return build({ repo, access, policy });
}
