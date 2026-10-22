import type { RepoTree } from '../generate/repo-types.js';
import { isSourceCode, textFiles } from './file-kinds.js';
import { scanSource } from './lexer.js';
import type { BugTruth } from './truth-types.js';

/** One file's lines three ways: original, code only (comments and string contents blanked), and the unreachable lines. */
interface FileLines {
  raw: string[];
  code: string[];
  unreachable: Set<number>;
}

/** Lines (0-based) of non-exported functions that nothing in the file calls: bugs there can never run. */
function unreachableLines(code: string[]): Set<number> {
  const all = code.join('\n');
  const unreachable = new Set<number>();
  code.forEach((line, start) => {
    const declared = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (declared?.[1] == null) return;
    const uses = all.match(new RegExp(`\\b${declared[1]}\\b`, 'g'))?.length ?? 0;
    if (uses > 1) return;
    for (let offset = start; offset < code.length; offset += 1) {
      unreachable.add(offset);
      if (code[offset] === '}') break;
    }
  });
  return unreachable;
}

/** The function body around line `at`: from the nearest preceding top-level declaration to its closing `}`. */
function bodyAround(params: { code: string[]; at: number }): string[] {
  const { code, at } = params;
  let start = at;
  while (start > 0 && !/^(export\s+)?(async\s+)?function\b/.test(code[start] ?? '')) start -= 1;
  let end = at;
  while (end < code.length - 1 && code[end] !== '}') end += 1;
  return code.slice(start, end + 1);
}

type Rule = (params: { lines: FileLines; at: number }) => BugTruth['cause'] | undefined;

/** One rule per root cause; each looks at a line (with its neighbours) and names the cause when the line is that bug. */
const RULES: Rule[] = [
  ({ lines: { code }, at }) => (/for\s*\(let\s+(\w+)\s*=\s*0;\s*\1\s*<=\s*\w+\.length\s*;/.test(code[at] ?? '') ? 'off-by-one' : undefined),
  ({ lines: { code }, at }) => {
    const found = /const\s+(\w+)\s*=\s*[\w.]+\.find\(/.exec(code[at - 1] ?? '');
    return found?.[1] != null && new RegExp(`\\b${found[1]}\\.`).test(code[at] ?? '') && !/if\s*\(/.test(code[at] ?? '') ? 'null-deref' : undefined;
  },
  ({ lines: { code }, at }) => {
    const read = /const\s+(\w+)\s*=\s*await\s+(\w+)\.read\(/.exec(code[at - 1] ?? '');
    const guarded = code.slice(Math.max(0, at - 3), at).some(line => /\.withLock\(/.test(line));
    return read?.[1] != null && new RegExp(`await\\s+${read[2]}\\.write\\(.*\\b${read[1]}\\s*\\+`).test(code[at] ?? '') && !guarded ? 'race' : undefined;
  },
  ({ lines: { code }, at }) => (/!==\s*null\s*\|\|\s*\w+\s*!==\s*undefined/.test(code[at] ?? '') ? 'wrong-operator' : undefined),
  ({ lines: { code }, at }) => {
    const opened = /const\s+(\w+)\s*=\s*await\s+open\(/.exec(code[at] ?? '');
    return opened?.[1] != null && !bodyAround({ code, at }).some(line => line.includes(`${opened[1]}.close(`)) ? 'resource-leak' : undefined;
  },
  ({ lines: { raw }, at }) => (/\.query\(\s*(?:"[^"]*"|'[^']*')\s*\+/.test(raw[at] ?? '') ? 'injection' : undefined),
  ({ lines: { code, raw }, at }) => (/\.get(?:Hours|Date|Day|Month|FullYear|Minutes)\(\)/.test(code[at] ?? '') && !/local time is intended/i.test(raw[at - 1] ?? '') ? 'timezone' : undefined),
  ({ lines: { code, raw }, at }) => (/catch\s*(?:\(\w+\))?\s*\{\s*$/.test(code[at] ?? '') && (raw[at + 1] ?? '').trim() === '}' ? 'swallowed-error' : undefined),
  ({ lines: { code }, at }) => (/\b(?:pageSize|limit|batchSize|perPage)\s*=\s*0\b/.test(code[at] ?? '') && /function|=>/.test(code[at] ?? '') ? 'wrong-default' : undefined),
  ({ lines: { code }, at }) => (/\bheight\s*=\s*(\w+)\.(?:right|left)\s*-|\bwidth\s*=\s*(\w+)\.(?:top|bottom)\s*-/.test(code[at] ?? '') ? 'copy-paste' : undefined),
];

/** Every real bug in hand-written source: each line checked against every rule, unreachable code and tests excluded. */
export function findBugs(tree: RepoTree): BugTruth[] {
  const bugs: BugTruth[] = [];
  for (const { path, text } of textFiles(tree)) {
    if (!isSourceCode(path)) continue;
    const raw = text.split('\n');
    const code = scanSource(text).code.split('\n');
    const lines: FileLines = { raw, code, unreachable: unreachableLines(code) };
    for (let at = 0; at < code.length; at += 1) {
      if (lines.unreachable.has(at)) continue;
      for (const rule of RULES) {
        const cause = rule({ lines, at });
        if (cause != null) bugs.push({ path, line: at + 1, cause });
      }
    }
  }
  return bugs.sort((first, second) => first.path.localeCompare(second.path) || first.line - second.line);
}
