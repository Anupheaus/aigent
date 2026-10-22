/** What kind of text a source is, which decides where it may be split. */
export type TextKind = 'markdown' | 'code' | 'text';

/** No break may be made at this position. */
export const NO_BREAK = -1;
/** Break strengths: higher is a better place to end a chunk. */
const WHITESPACE = 0;
const LINE = 1;
const SENTENCE = 2;
const PARAGRAPH = 3;
/** Headings and top-level declarations: chunks ending here start the next one without overlap. */
export const STRUCTURE = 4;

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'cs', 'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'kt', 'swift', 'scala', 'sh']);
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const DECLARATION = /^(?:export[ \t]+(?:default[ \t]+)?)?(?:async[ \t]+)?(?:function|class|interface|type|enum|const|let|var|def|fn|pub|impl|struct|trait|namespace|module)\b/;
const SENTENCE_END = /[.!?]/;

/** A markdown heading: where its line starts, its level and its text. */
export interface Heading {
  at: number;
  level: number;
  title: string;
}

/** Where a text may be split and how good each place is, plus the markdown headings. */
export interface Boundaries {
  /** `strength[p]` for a chunk ending at `p` (and the next starting there): `NO_BREAK` or 0 (weakest) to 4. */
  strength: Int8Array;
  headings: Heading[];
}

/** The kind of a source by its URI's extension: markdown, code, or plain text. */
export function kindOf(uri: string): TextKind {
  const extension = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(uri)?.[1]?.toLowerCase() ?? '';
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  return CODE_EXTENSIONS.has(extension) ? 'code' : 'text';
}

interface Line {
  start: number;
  text: string;
}

/** Lines without their terminator: a CRLF line's `\r` is dropped too, so `$` in the line patterns matches. */
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const rawText of text.split('\n')) {
    lines.push({ start, text: rawText.endsWith('\r') ? rawText.slice(0, -1) : rawText });
    start += rawText.length + 1;
  }
  return lines;
}

/** The fence a line opens or closes, given the one open before it (CommonMark: a closer uses the same character, at least as long). */
function nextFence(params: { line: Line; open?: string }): { open?: string; closed: boolean } {
  const { line, open } = params;
  const marker = FENCE.exec(line.text)?.[1];
  if (marker == null) return { ...(open == null ? {} : { open }), closed: false };
  if (open == null) return { open: marker, closed: false };
  if (marker[0] !== open[0] || marker.length < open.length) return { open, closed: false };
  return { closed: true };
}

function raise(params: { strength: Int8Array; at: number; value: number }): void {
  const { strength, at, value } = params;
  if (at > 0 && at < strength.length - 1 && strength[at] !== NO_BREAK) strength[at] = Math.max(strength[at] ?? WHITESPACE, value);
}

/** Every position after whitespace may end a chunk (weakly); sentence ends are better. */
function markWhitespace(params: { text: string; strength: Int8Array }): void {
  const { text, strength } = params;
  for (let at = 1; at < text.length; at += 1) {
    if (!/\s/.test(text[at - 1] ?? '') || /\s/.test(text[at] ?? '')) continue;
    strength[at] = WHITESPACE;
    const before = text.slice(Math.max(0, at - 3), at).trimEnd();
    if (SENTENCE_END.test(before.at(-1) ?? '')) strength[at] = SENTENCE;
  }
}

/** Positions inside fenced code blocks no longer than `maxFence` characters may not end a chunk. */
function blockFences(params: { lines: Line[]; strength: Int8Array; maxFence: number }): void {
  const { lines, strength, maxFence } = params;
  let open: { at: number; marker: string } | undefined;
  for (const line of lines) {
    const fence = nextFence({ line, ...(open == null ? {} : { open: open.marker }) });
    if (!fence.closed) {
      if (open == null && fence.open != null) open = { at: line.start, marker: fence.open };
      continue;
    }
    if (open == null) continue;
    const end = line.start + line.text.length;
    if (end - open.at <= maxFence) strength.fill(NO_BREAK, open.at + 1, end);
    open = undefined;
  }
}

/** The places a text may be split, by its kind; fenced blocks up to `maxFence` characters stay whole. */
export function findBoundaries(params: { text: string; kind: TextKind; maxFence: number }): Boundaries {
  const { text, kind, maxFence } = params;
  const strength = new Int8Array(text.length + 1).fill(NO_BREAK);
  markWhitespace({ text, strength });
  const lines = linesOf(text);
  const headings: Heading[] = [];
  let previousBlank = false;
  let openFence: string | undefined;
  for (const line of lines) {
    const isBlank = line.text.trim() === '';
    raise({ strength, at: line.start, value: previousBlank ? PARAGRAPH : LINE });
    // A `#` line inside a fenced block is code (a shell comment, say), not a heading.
    const wasInFence = openFence != null;
    if (kind === 'markdown') {
      const fence = nextFence({ line, ...(openFence == null ? {} : { open: openFence }) });
      openFence = fence.open;
    }
    if (kind === 'markdown' && !wasInFence) {
      const heading = HEADING.exec(line.text);
      if (heading != null) {
        headings.push({ at: line.start, level: heading[1]?.length ?? 1, title: heading[2] ?? '' });
        raise({ strength, at: line.start, value: STRUCTURE });
      }
    }
    if (kind === 'code' && DECLARATION.test(line.text)) raise({ strength, at: line.start, value: STRUCTURE });
    previousBlank = isBlank;
  }
  if (kind === 'markdown') blockFences({ lines, strength, maxFence });
  return { strength, headings };
}

/** The heading path (`Guide > Install`) in effect at `at`. */
export function sectionAt(params: { headings: Heading[]; at: number }): string | undefined {
  const { headings, at } = params;
  const stack: Heading[] = [];
  for (const heading of headings) {
    if (heading.at > at) break;
    while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
    stack.push(heading);
  }
  return stack.length === 0 ? undefined : stack.map(({ title }) => title).join(' > ');
}
