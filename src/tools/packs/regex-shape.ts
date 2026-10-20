/**
 * A structural scan of a regular expression for shapes that backtrack badly. It is a first filter only: it cannot
 * prove a pattern safe, so model patterns also run under a hard time limit (see `bounded-regex.ts`).
 */

/** One group being scanned: where its body and alternatives start, and what it holds. */
interface Frame {
  openAt: number;
  bodyStart: number;
  /** Positions of the `|` at this group's own level. */
  bars: number[];
  /** A quantifier occurs anywhere inside (nested groups included). */
  hasQuantifier: boolean;
  /** A group of overlapping alternatives occurs anywhere inside. */
  hasOverlap: boolean;
  /** The last atom, when it is a single-character matcher repeated without an upper bound (for adjacency). */
  lastUnbounded?: string;
}

interface Atom {
  kind: 'char' | 'group';
  raw: string;
  end: number;
  hasQuantifier?: boolean;
  /** The group, or a group inside it, has overlapping alternatives. */
  hasOverlap?: boolean;
}

/** Code points sampled to decide whether two single-character matchers can match the same character. */
const SAMPLE_CODE_POINTS = 0x300;
const GROUP_PREFIX = /^\((?:\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>))?/;
const QUANTIFIER = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/;
/** Alternatives that are not plain text (wildcards, classes, escapes) may overlap in ways a prefix test cannot see. */
const NON_LITERAL = /[.\\[(]/;

function readEscape(params: { pattern: string; at: number }): number {
  const { pattern, at } = params;
  const next = pattern[at + 1] ?? '';
  if (next === 'u' && pattern[at + 2] === '{') return pattern.indexOf('}', at) + 1 || pattern.length;
  if ((next === 'p' || next === 'P') && pattern[at + 2] === '{') return pattern.indexOf('}', at) + 1 || pattern.length;
  if (next === 'k' && pattern[at + 2] === '<') return pattern.indexOf('>', at) + 1 || pattern.length;
  if (next === 'u') return at + 6;
  if (next === 'x') return at + 4;
  if (next === 'c') return at + 3;
  return at + 2;
}

function readClass(params: { pattern: string; at: number }): number {
  const { pattern } = params;
  let at = params.at + 1;
  if (pattern[at] === '^') at += 1;
  while (at < pattern.length && pattern[at] !== ']') at = pattern[at] === '\\' ? readEscape({ pattern, at }) : at + 1;
  return at + 1;
}

/** Whether two single-character matchers share a character (sampled; flags apply, e.g. `i`). */
function overlaps(params: { first: string; second: string; flags: string }): boolean {
  const { first, second, flags } = params;
  try {
    const one = new RegExp(`^(?:${first})$`, flags);
    const other = new RegExp(`^(?:${second})$`, flags);
    for (let code = 0; code < SAMPLE_CODE_POINTS; code += 1) {
      const character = String.fromCodePoint(code);
      if (one.test(character) && other.test(character)) return true;
    }
    return false;
  } catch {
    // Not checkable on its own: assume the worst.
    return true;
  }
}

/** Alternatives where one is a prefix of another (`a|aa`, `a|A` under `i`), or that are not plain text. */
function alternativesOverlap(params: { alternatives: string[]; flags: string }): boolean {
  const { flags } = params;
  const alternatives = flags.includes('i') ? params.alternatives.map(alternative => alternative.toLowerCase()) : params.alternatives;
  if (alternatives.some(alternative => alternative === '' || NON_LITERAL.test(alternative))) return true;
  return alternatives.some((alternative, index) => alternatives.some((other, otherIndex) => otherIndex !== index && other.startsWith(alternative)));
}

/** The single-character atom (literal, escape or class) starting at `at`. */
function readAtom(params: { pattern: string; at: number }): Atom {
  const { pattern, at } = params;
  const character = pattern[at] ?? '';
  if (character === '\\') return { kind: 'char', raw: pattern.slice(at, readEscape({ pattern, at })), end: readEscape({ pattern, at }) };
  if (character === '[') return { kind: 'char', raw: pattern.slice(at, readClass({ pattern, at })), end: readClass({ pattern, at }) };
  const width = (pattern.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
  return { kind: 'char', raw: pattern.slice(at, at + width), end: at + width };
}

/** Why the pattern's shape can backtrack catastrophically, or undefined when the scan found nothing. */
export function unsafeShape(params: { pattern: string; flags: string }): string | undefined {
  const { pattern, flags } = params;
  const matchFlags = flags.replace(/g/g, '');
  const frames: Frame[] = [{ openAt: -1, bodyStart: 0, bars: [], hasQuantifier: false, hasOverlap: false }];
  for (let at = 0; at < pattern.length;) {
    const frame = frames.at(-1) as Frame;
    const character = pattern[at] ?? '';
    if (character === '(') {
      const prefix = GROUP_PREFIX.exec(pattern.slice(at))?.[0] ?? '(';
      frames.push({ openAt: at, bodyStart: at + prefix.length, bars: [], hasQuantifier: false, hasOverlap: false });
      at += prefix.length;
      continue;
    }
    if (character === '|' || character === '^' || character === '$') {
      if (character === '|') frame.bars.push(at);
      frame.lastUnbounded = undefined;
      at += 1;
      continue;
    }
    let atom: Atom;
    if (character === ')' && frames.length > 1) {
      frames.pop();
      const parent = frames.at(-1) as Frame;
      parent.hasQuantifier ||= frame.hasQuantifier;
      const cuts = [frame.bodyStart, ...frame.bars.map(bar => bar + 1)];
      const alternatives = cuts.map((start, index) => pattern.slice(start, (frame.bars[index] ?? at)));
      const hasOverlap = frame.hasOverlap || (alternatives.length > 1 && alternativesOverlap({ alternatives, flags }));
      parent.hasOverlap ||= hasOverlap;
      atom = { kind: 'group', raw: pattern.slice(frame.openAt, at + 1), end: at + 1, hasQuantifier: frame.hasQuantifier, hasOverlap };
    } else {
      atom = readAtom({ pattern, at });
    }
    const owner = frames.at(-1) as Frame;
    const quantifier = QUANTIFIER.exec(pattern.slice(atom.end));
    at = atom.end + (quantifier?.[0].length ?? 0);
    if (quantifier == null) { owner.lastUnbounded = undefined; continue; }
    const [, symbol, minimum, comma, maximum] = quantifier;
    const isUnbounded = symbol === '*' || symbol === '+' || (comma != null && maximum === '');
    const repeats = symbol !== '?' && (isUnbounded || Number(maximum ?? minimum) > 1);
    owner.hasQuantifier = true;
    if (atom.kind === 'group' && repeats && atom.hasQuantifier === true) return 'it repeats a group that itself repeats, which can take exponential time';
    if (atom.kind === 'group' && repeats && atom.hasOverlap === true) return 'it repeats a group of overlapping alternatives, which can take exponential time';
    if (atom.kind === 'char' && isUnbounded && owner.lastUnbounded != null && overlaps({ first: owner.lastUnbounded, second: atom.raw, flags: matchFlags })) return 'it has adjacent unbounded repetitions of overlapping characters, which can take polynomial time';
    owner.lastUnbounded = atom.kind === 'char' && isUnbounded ? atom.raw : undefined;
  }
  return undefined;
}
