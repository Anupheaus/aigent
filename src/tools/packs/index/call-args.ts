/** One top-level argument of a call: its code (comments and string contents blanked) and its original text. */
export interface CallArg {
  code: string;
  text: string;
}

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const STRING_LITERAL = /^(['"])([^'"]*)\1$/;
const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * The top-level arguments of the call whose `(` is at `open` in `code` (from `codeOnly`, the same length as `text`),
 * or undefined when the call is not closed. Strings are blanked in `code`, so brackets and commas inside them never
 * count; each argument's text is read back from `text` at the same offsets.
 */
export function callArgs(params: { code: string; text: string; open: number }): CallArg[] | undefined {
  const { code, text, open } = params;
  const args: CallArg[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open + 1; at < code.length; at += 1) {
    const char = code[at] ?? '';
    if (OPENERS.has(char)) depth += 1;
    else if (CLOSERS.has(char) && depth > 0) depth -= 1;
    else if ((char === ',' || char === ')') && depth === 0) {
      const arg = { code: code.slice(start, at).trim(), text: text.slice(start, at).trim() };
      if (arg.code !== '' || char === ',') args.push(arg);
      if (char === ')') return args;
      start = at + 1;
    }
  }
  return undefined;
}

/** The value of a plain string literal argument (`'/users'`), or undefined. */
export const stringArg = (arg: CallArg | undefined): string | undefined => (arg == null ? undefined : STRING_LITERAL.exec(arg.text)?.[2]);

/** The name of an argument that is a bare identifier or a member path (`getUser`, `users.get`), or undefined. */
export const nameArg = (arg: CallArg | undefined): string | undefined => (arg != null && IDENTIFIER_PATH.test(arg.code) ? arg.code : undefined);
