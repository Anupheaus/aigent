import type { Tool } from '../../../src/index.js';
import { createFsPolicy, fsTools } from '../../../src/tools/packs/fs/index.js';
import type { FsAccess, FsPolicy, FsToolsOptions } from '../../../src/tools/packs/fs/index.js';
import type { GeneratedRepo } from '../generate/repo-types.js';
import type { TrapSetup } from '../task-spec.js';
import { withFailingReads, withMutatingReads } from './trap-access.js';

/** The Round-0 tool set: the plain filesystem tools, no index. */
export const ROUND_0_TOOLS = ['fs_list', 'fs_read', 'fs_search'] as const;

/** The policy's default deny globs (kept when a trap adds its own, since given globs replace the defaults). */
const DEFAULT_DENY_GLOBS = ['.git/**', '**/.env', '**/.env.*', '**/*.pem', '**/*.key'];

/** A tool-set builder: the tools a round offers over a repository's access and policy. */
export type ToolSetBuilder = (params: { repo: GeneratedRepo; access: FsAccess; policy: ReturnType<typeof createFsPolicy> }) => Tool[];

/**
 * A search's regex budget in the bench: the library's 10 s default is a wall-clock limit, so on a loaded machine a
 * search stopped early and the run's results (and tokens) changed. The bench measures counts that must not depend on
 * load, so its searches get more time than any run's declared time.
 */
export const BENCH_SEARCH_BUDGET_MS = 120_000;
/** Every bench tool's call timeout, above the search budget, for the same reason (the default is 30 s). */
export const BENCH_TOOL_TIMEOUT_MS = 180_000;

/** The filesystem tools' options in the bench: no approvals, the bench's search budget. */
export function benchFsOptions(params: { access: FsAccess; policy: FsPolicy }): FsToolsOptions {
  const { access, policy } = params;
  return { access, policy, approvals: 'none', searchBudgetMs: BENCH_SEARCH_BUDGET_MS };
}

export const round0Tools: ToolSetBuilder = ({ access, policy }) => fsTools(benchFsOptions({ access, policy })).filter(tool => (ROUND_0_TOOLS as readonly string[]).includes(tool.name));

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
  return build({ repo, access, policy }).map(tool => ({ ...tool, timeoutMs: BENCH_TOOL_TIMEOUT_MS }));
}
