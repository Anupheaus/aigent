/** One changed path in `git status`. */
export interface StatusEntry {
  path: string;
  /** Index (staged) state: `M`, `A`, `D`, `R`, `C`, `U`, `.` (unchanged), `?` (untracked) or `!` (ignored). */
  index: string;
  /** Work-tree state, with the same letters. */
  worktree: string;
  /** The path a rename or copy came from. */
  origPath?: string;
}

export interface StatusSummary {
  branch: string | null;
  commit: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

/** Parses `git status --porcelain=v2 -z --branch`. */
export function parseStatus(output: string): StatusSummary {
  const summary: StatusSummary = { branch: null, commit: null, ahead: 0, behind: 0, entries: [] };
  const records = output.split('\0');
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at] ?? '';
    if (record.startsWith('# branch.head ')) { const head = record.slice('# branch.head '.length); summary.branch = head === '(detached)' ? null : head; continue; }
    if (record.startsWith('# branch.oid ')) { const oid = record.slice('# branch.oid '.length); summary.commit = oid === '(initial)' ? null : oid; continue; }
    if (record.startsWith('# branch.upstream ')) { summary.upstream = record.slice('# branch.upstream '.length); continue; }
    if (record.startsWith('# branch.ab ')) {
      const [ahead = '+0', behind = '-0'] = record.slice('# branch.ab '.length).split(' ');
      summary.ahead = Number(ahead.slice(1));
      summary.behind = Number(behind.slice(1));
      continue;
    }
    const kind = record[0];
    if (kind === '?' || kind === '!') { summary.entries.push({ path: record.slice(2), index: kind, worktree: kind }); continue; }
    // `1 XY sub mH mI mW hH hI path`, `2 XY sub mH mI mW hH hI Xscore path` + NUL + origPath, `u XY sub m1 m2 m3 mW h1 h2 h3 path`.
    const fieldsBeforePath = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : undefined;
    if (fieldsBeforePath == null) continue;
    const parts = record.split(' ');
    const [index = '.', worktree = '.'] = [...(parts[1] ?? '..')];
    const path = parts.slice(fieldsBeforePath).join(' ');
    if (kind === '2') { at += 1; summary.entries.push({ path, index, worktree, origPath: records[at] ?? '' }); continue; }
    summary.entries.push({ path, index, worktree });
  }
  return summary;
}

/** Totals from `git diff --numstat -z` (binary files count as changed with no line counts). */
export function parseNumstat(output: string): { files: number; insertions: number; deletions: number } {
  const records = output.split('\0');
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at] ?? '';
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(record);
    if (match == null) continue;
    files += 1;
    insertions += match[1] === '-' ? 0 : Number(match[1]);
    deletions += match[2] === '-' ? 0 : Number(match[2]);
    // A rename has an empty path here, then its source and destination as two more records.
    if (match[3] === '') at += 2;
  }
  return { files, insertions, deletions };
}

/** Every path in `git diff --numstat -z`, in git's order, a rename giving its source and its destination. */
export function numstatPaths(output: string): string[] {
  const records = output.split('\0');
  const paths: string[] = [];
  for (let at = 0; at < records.length; at += 1) {
    const match = /^(?:-|\d+)\t(?:-|\d+)\t([\s\S]*)$/.exec(records[at] ?? '');
    if (match == null) continue;
    const [, path = ''] = match;
    if (path !== '') { paths.push(path); continue; }
    paths.push(records[at + 1] ?? '', records[at + 2] ?? '');
    at += 2;
  }
  return [...new Set(paths.filter(path => path !== ''))];
}

/** Separates the fields of one `git log` record (the unit separator never appears in names or subjects). */
export const LOG_FIELD_SEPARATOR = '\u001f';
/** `--format` for `parseLog`: hash, author, ISO date, subject. */
export const LOG_FORMAT = ['%H', '%an <%ae>', '%aI', '%s'].join('%x1f');

export interface LogCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

/** Parses `git log -z --format=LOG_FORMAT`. */
export function parseLog(output: string): LogCommit[] {
  return output.split('\0').filter(record => record.trim() !== '').map(record => {
    const [hash = '', author = '', date = '', subject = ''] = record.replace(/^\n/, '').split(LOG_FIELD_SEPARATOR);
    return { hash, author, date, subject };
  });
}
