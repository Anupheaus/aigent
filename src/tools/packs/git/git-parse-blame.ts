/** One line of `git blame`. */
export interface BlameLine {
  line: number;
  hash: string;
  author: string;
  /** ISO 8601 with the author's offset. */
  date: string;
  text: string;
}

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: \d+)?$/;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;

/** `1700000000` and `+0100` as `2023-11-14T23:13:20+01:00` (`+0000` as `...Z`). */
function isoDate(params: { seconds: number; zone: string }): string {
  const { seconds, zone } = params;
  const match = /^([+-])(\d{2})(\d{2})$/.exec(zone);
  const sign = match?.[1] === '-' ? -1 : 1;
  const offsetMinutes = match == null ? 0 : sign * (Number(match[2]) * MINUTES_PER_HOUR + Number(match[3]));
  const local = new Date(seconds * MS_PER_SECOND + offsetMinutes * MS_PER_MINUTE).toISOString().slice(0, 19);
  // UTC is written as Z, as git's own strict ISO dates (%aI) do.
  return match == null || offsetMinutes === 0 ? `${local}Z` : `${local}${match[1]}${match[2]}:${match[3]}`;
}

/** Parses `git blame --porcelain`: commit details come once per commit, then apply to each of its lines. */
export function parseBlame(output: string): BlameLine[] {
  const commits = new Map<string, { author: string; time: number; zone: string }>();
  const lines: BlameLine[] = [];
  let current: { hash: string; line: number } | undefined;
  for (const row of output.split('\n')) {
    const header = HEADER.exec(row);
    if (header != null) {
      current = { hash: header[1] ?? '', line: Number(header[3]) };
      if (!commits.has(current.hash)) commits.set(current.hash, { author: '', time: 0, zone: '+0000' });
      continue;
    }
    if (current == null) continue;
    const details = commits.get(current.hash);
    if (details == null) continue;
    if (row.startsWith('author ')) details.author = row.slice('author '.length);
    else if (row.startsWith('author-mail ')) details.author = `${details.author} ${row.slice('author-mail '.length)}`;
    else if (row.startsWith('author-time ')) details.time = Number(row.slice('author-time '.length));
    else if (row.startsWith('author-tz ')) details.zone = row.slice('author-tz '.length);
    else if (row.startsWith('\t')) {
      lines.push({ line: current.line, hash: current.hash, author: details.author, date: isoDate({ seconds: details.time, zone: details.zone }), text: row.slice(1) });
      current = undefined;
    }
  }
  return lines;
}
