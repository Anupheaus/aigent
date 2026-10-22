import { codeLines } from './code-lines.js';

/** One suspected bug: 1-based line and a cause a reviewer would write. */
export interface BugReport {
  line: number;
  cause: string;
}

/** The searches a reviewer runs to find suspicious constructs (regular expressions over code). */
export const RISK_PATTERNS: readonly string[] = [
  'for \\(let \\w+ = 0; \\w+ <= \\w+\\.length',
  '\\.find\\(',
  'await \\w+\\.read\\(',
  '!== null \\|\\|',
  'await open\\(',
  '\\.query\\(\\s*"',
  '\\.get(Hours|Date|Day|Month|FullYear|Minutes)\\(\\)',
  'catch (\\(\\w+\\) )?\\{$',
  '(pageSize|limit|batchSize|perPage)\\s*=\\s*0\\b',
  '(height|width)\\s*=\\s*\\w+\\.(right|left|top|bottom)\\s*-',
];

/** Lines (0-based) inside functions that are neither exported nor called: dead code cannot misbehave. */
function deadLines(code: string[]): Set<number> {
  const dead = new Set<number>();
  const joined = code.join('\n');
  code.forEach((line, start) => {
    const name = /^function\s+(\w+)/.exec(line)?.[1];
    if (name == null || (joined.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length > 1) return;
    for (let index = start; index < code.length; index += 1) { dead.add(index); if (code[index] === '}') break; }
  });
  return dead;
}

/** The enclosing function's lines, for checks that need the whole body (a close in `finally`). */
function functionAround(params: { code: string[]; at: number }): string {
  const { code, at } = params;
  let start = at;
  while (start > 0 && !/function\b/.test(code[start] ?? '')) start -= 1;
  let end = at;
  while (end < code.length - 1 && code[end] !== '}') end += 1;
  return code.slice(start, end + 1).join('\n');
}

type Check = (params: { code: string[]; raw: string[]; at: number }) => string | undefined;

/** A reviewer's judgement of each kind of suspicious line (guards, locks, explanations and dead code respected). */
const CHECKS: Check[] = [
  ({ code, at }) => (/<=\s*\w+\.length\s*;/.test(code[at] ?? '') ? 'off-by-one: the loop runs one past the end of the array' : undefined),
  ({ code, at }) => {
    const variable = /const (\w+) = .*\.find\(/.exec(code[at - 1] ?? '')?.[1];
    return variable != null && new RegExp(`\\b${variable}\\.`).test(code[at] ?? '') && !/\bif\b/.test(code[at] ?? '') ? 'null dereference: find may return undefined' : undefined;
  },
  ({ code, at }) => (/await \w+\.write\(/.test(code[at] ?? '') && /await \w+\.read\(/.test(code[at - 1] ?? '') && !code.slice(Math.max(0, at - 3), at).some(line => /\.withLock\(/.test(line)) ? 'race condition: read-modify-write without a lock loses updates' : undefined),
  ({ code, at }) => (/!== null \|\|/.test(code[at] ?? '') ? 'wrong operator: || makes the check always true' : undefined),
  ({ code, at }) => {
    const handle = /const (\w+) = await open\(/.exec(code[at] ?? '')?.[1];
    return handle != null && !functionAround({ code, at }).includes(`${handle}.close(`) ? 'resource leak: the file handle is never closed' : undefined;
  },
  ({ raw, at }) => (/\.query\(\s*"[^"]*"\s*\+/.test(raw[at] ?? '') ? 'SQL injection: query built by string concatenation' : undefined),
  ({ code, raw, at }) => (/\.get(Hours|Date|Day|Month|FullYear|Minutes)\(\)/.test(code[at] ?? '') && !/local time is intended/i.test(raw[at - 1] ?? '') ? 'timezone: local time used for a UTC rule' : undefined),
  ({ code, raw, at }) => (/catch\s*(\(\w+\))?\s*\{\s*$/.test(code[at] ?? '') && (raw[at + 1] ?? '').trim() === '}' ? 'swallowed error: empty catch block' : undefined),
  ({ code, at }) => (/(pageSize|limit|batchSize|perPage)\s*=\s*0\b/.test(code[at] ?? '') ? 'wrong default: page size defaults to 0' : undefined),
  ({ code, at }) => (/height\s*=\s*\w+\.(right|left)\s*-|width\s*=\s*\w+\.(top|bottom)\s*-/.test(code[at] ?? '') ? 'copy-paste error: wrong side used (right instead of bottom)' : undefined),
];

/** A careful review of one file: every check on every live line. */
export function reviewFile(text: string): BugReport[] {
  const raw = text.split('\n');
  const code = codeLines(text);
  const dead = deadLines(code);
  return code.flatMap((_line, at) => (dead.has(at) ? [] : CHECKS.flatMap(check => {
    const cause = check({ code, raw, at });
    return cause == null ? [] : [{ line: at + 1, cause }];
  })));
}
