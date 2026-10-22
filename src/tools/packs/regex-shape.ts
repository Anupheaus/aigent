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
  /** A lookaround: it never consumes, so it neither separates nor extends the repetitions around it. */
  isLookaround: boolean;
  /**
   * Single-character matchers repeated without an upper bound that can sit right before the next atom: the last
   * unbounded one, plus any earlier ones only atoms that may match nothing (`a?`, `()`, `\B`) stand between.
   */
  pending: string[];
  /** `pending` as the group was entered: each alternative starts from it. */
  entryPending: string[];
  /** `pending` at the end of each finished alternative: what the group leaves before the next atom. */
  exitPending: string[];
  /** The current alternative holds an atom that must consume at least one character. */
  altConsumes: boolean;
  /** Some finished alternative can match nothing. */
  anyAltEmpty: boolean;
}

interface Atom {
  kind: 'char' | 'group';
  raw: string;
  end: number;
  hasQuantifier?: boolean;
  /** The group, or a group inside it, has overlapping alternatives. */
  hasOverlap?: boolean;
  /** The group can match nothing (it is a lookaround, or one of its alternatives consumes nothing). */
  canBeEmpty?: boolean;
  /** The unbounded matchers the group leaves before the next atom. */
  exitPending?: string[];
}

/** Code points sampled to decide whether two single-character matchers can match the same character. */
const SAMPLE_CODE_POINTS = 0x300;
const GROUP_PREFIX = /^\((?:\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>))?/;
const LOOKAROUND_PREFIXES: ReadonlySet<string> = new Set(['(?=', '(?!', '(?<=', '(?<!']);
const QUANTIFIER = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/;
/** Alternatives that are not plain text (wildcards, classes, escapes) may overlap in ways a prefix test cannot see. */
const NON_LITERAL = /[.\\[(]/;
/** Zero-width escapes: word boundaries match between characters and consume nothing. */
const ZERO_WIDTH_ESCAPES: ReadonlySet<string> = new Set(['\\b', '\\B']);

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

function newFrame(params: { openAt: number; prefix: string; pending: string[] }): Frame {
  const { openAt, prefix, pending } = params;
  return {
    openAt, bodyStart: openAt + prefix.length, bars: [], hasQuantifier: false, hasOverlap: false, isLookaround: LOOKAROUND_PREFIXES.has(prefix),
    pending: [...pending], entryPending: [...pending], exitPending: [], altConsumes: false, anyAltEmpty: false,
  };
}

/** Closes the frame's current alternative: records what it leaves behind and whether it can match nothing. */
function endAlternative(frame: Frame): void {
  frame.exitPending.push(...frame.pending);
  if (!frame.altConsumes) frame.anyAltEmpty = true;
  frame.altConsumes = false;
  frame.pending = [...frame.entryPending];
}

/** How many unbounded quantifiers (`*`, `+`, `{n,}`) the pattern holds, outside escapes and character classes. */
export function countUnboundedQuantifiers(pattern: string): number {
  let count = 0;
  for (let at = 0; at < pattern.length;) {
    const character = pattern[at] ?? '';
    if (character === '\\') { at = readEscape({ pattern, at }); continue; }
    if (character === '[') { at = readClass({ pattern, at }); continue; }
    const quantifier = character === '*' || character === '+' || character === '{' ? QUANTIFIER.exec(pattern.slice(at)) : null;
    if (quantifier == null) { at += 1; continue; }
    const [, symbol, , comma, maximum] = quantifier;
    if (symbol === '*' || symbol === '+' || (comma != null && maximum === '')) count += 1;
    at += quantifier[0].length;
  }
  return count;
}

/** Why the pattern's shape can backtrack catastrophically, or undefined when the scan found nothing. */
export function unsafeShape(params: { pattern: string; flags: string }): string | undefined {
  const { pattern, flags } = params;
  const matchFlags = flags.replace(/g/g, '');
  const frames: Frame[] = [newFrame({ openAt: -1, prefix: '(', pending: [] })];
  for (let at = 0; at < pattern.length;) {
    const frame = frames.at(-1) as Frame;
    const character = pattern[at] ?? '';
    if (character === '(') {
      const prefix = GROUP_PREFIX.exec(pattern.slice(at))?.[0] ?? '(';
      // A group's first atom can follow whatever came before the group.
      frames.push(newFrame({ openAt: at, prefix, pending: frame.pending }));
      at += prefix.length;
      continue;
    }
    if (character === '|') {
      frame.bars.push(at);
      endAlternative(frame);
      at += 1;
      continue;
    }
    // Anchors consume nothing (`$` under `m` sits before a newline that `\s+` can match), so they separate nothing.
    if (character === '^' || character === '$') { at += 1; continue; }
    let atom: Atom;
    if (character === ')' && frames.length > 1) {
      frames.pop();
      endAlternative(frame);
      const parent = frames.at(-1) as Frame;
      parent.hasQuantifier ||= frame.hasQuantifier;
      const cuts = [frame.bodyStart, ...frame.bars.map(bar => bar + 1)];
      const alternatives = cuts.map((start, index) => pattern.slice(start, (frame.bars[index] ?? at)));
      const hasOverlap = frame.hasOverlap || (alternatives.length > 1 && alternativesOverlap({ alternatives, flags }));
      parent.hasOverlap ||= hasOverlap;
      atom = {
        kind: 'group', raw: pattern.slice(frame.openAt, at + 1), end: at + 1, hasQuantifier: frame.hasQuantifier, hasOverlap,
        canBeEmpty: frame.isLookaround || frame.anyAltEmpty, exitPending: frame.isLookaround ? [] : [...new Set(frame.exitPending)],
      };
    } else {
      atom = readAtom({ pattern, at });
      if (ZERO_WIDTH_ESCAPES.has(atom.raw)) { at = atom.end; continue; }
    }
    const owner = frames.at(-1) as Frame;
    const quantifier = QUANTIFIER.exec(pattern.slice(atom.end));
    at = atom.end + (quantifier?.[0].length ?? 0);
    const [, symbol, minimum, comma, maximum] = quantifier ?? [];
    const isUnbounded = symbol === '*' || symbol === '+' || (comma != null && maximum === '');
    const repeats = quantifier != null && symbol !== '?' && (isUnbounded || Number(maximum ?? minimum) > 1);
    const isOptional = symbol === '?' || symbol === '*' || minimum === '0';
    if (quantifier != null) owner.hasQuantifier = true;
    if (atom.kind === 'group') {
      if (repeats && atom.hasQuantifier === true) return 'it repeats a group that itself repeats, which can take exponential time';
      if (repeats && atom.hasOverlap === true) return 'it repeats a group of overlapping alternatives, which can take exponential time';
      const exitPending = atom.exitPending ?? [];
      // A group that can match nothing leaves the earlier repetitions adjacent to whatever follows it.
      if (atom.canBeEmpty === true || isOptional) { owner.pending = [...new Set([...owner.pending, ...exitPending])]; continue; }
      owner.pending = exitPending;
      owner.altConsumes = true;
      continue;
    }
    if (isUnbounded && owner.pending.some(earlier => overlaps({ first: earlier, second: atom.raw, flags: matchFlags }))) return 'it has adjacent unbounded repetitions of overlapping characters, which can take polynomial time';
    if (isOptional) {
      if (isUnbounded) owner.pending = [...owner.pending, atom.raw];
      continue;
    }
    owner.pending = isUnbounded ? [atom.raw] : [];
    owner.altConsumes = true;
  }
  return undefined;
}
