import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool } from '../../tool-types.js';
import { parseBlame } from './git-parse-blame.js';
import { openRepo, runGit } from './git-run.js';
import { MAX_GIT_ITEMS, repoTitle } from './git-shared.js';
import type { GitDeps } from './git-shared.js';
import { validRef, validRepoPath } from './git-validate.js';

export const GIT_BLAME_TOOL_NAME = 'git_blame';
/** Most lines blamed in one item; ask for a range for longer files. */
const MAX_BLAME_LINES = 2_000;

const blameItem = z.object({
  repo: z.string().min(1).optional().describe('Repository root (default: the workspace root)'),
  path: z.string().min(1).describe('File to blame, relative to the repository'),
  startLine: z.number().int().min(1).optional().describe('First line (1-based)'),
  endLine: z.number().int().min(1).optional().describe('Last line'),
  ref: z.string().min(1).optional().describe('Blame the file as of this commit (default: the work tree)'),
}).strict();

/** `git_blame`: who last changed each line, from `--porcelain`, per line `{ line, hash, author, date, text }`. */
export function createGitBlame(deps: GitDeps): Tool {
  return defineBatchTool({
    name: GIT_BLAME_TOOL_NAME,
    description: `Show, for each line of a file (or a line range), the commit, author and date that last changed it, with the line text. At most ${MAX_BLAME_LINES} lines per item.`,
    item: blameItem, maxItems: MAX_GIT_ITEMS, deterministic: false, cache: false, contentKind: 'structured-data', fidelity: 'verbatim',
    describeActivity: ({ items }) => ({ title: items.length === 1 && items[0] != null ? `Blaming ${items[0].path}` : repoTitle({ verb: 'Blaming files', items }) }),
    runItem: async ({ repo, path, startLine, endLine, ref }, { signal }) => {
      if (startLine != null && endLine != null && endLine < startLine) throw toolFailure({ code: 'invalid_range', message: `endLine ${endLine} is before startLine ${startLine}`, retryable: false });
      const opened = await openRepo({ deps, ...(repo == null ? {} : { repo }) });
      const relative = await validRepoPath({ deps, repo: opened.path, path });
      const first = startLine ?? 1;
      const last = Math.min(endLine ?? first + MAX_BLAME_LINES - 1, first + MAX_BLAME_LINES - 1);
      const range = startLine == null && endLine == null ? [] : [`-L${first},${last}`];
      const at = ref == null ? [] : [validRef({ field: 'ref', value: ref })];
      const { stdout } = await runGit({ deps, repo: opened, signal, args: ['blame', '--porcelain', '--no-textconv', ...range, ...at, '--', relative] });
      const lines = parseBlame(stdout);
      const shown = lines.slice(0, MAX_BLAME_LINES);
      return { repo: opened.path, path: relative, lines: shown, truncated: lines.length > shown.length };
    },
  });
}
