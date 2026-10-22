import type { FsAccess } from '../../../security/fs-access.js';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import type { FsPolicy } from '../../../security/fs-policy-types.js';
import { isToolFailure, toolFailure } from '../../tool-failure.js';
import { CODE_FILE } from './code-files.js';
import type { TsModules, TsSourceFile } from './ts-api.js';
import { loadTypeScript as loadInstalledTypeScript, typescriptUnavailable } from './ts-loader.js';
import { createProgramCache } from './ts-program.js';
import type { CodeProgram, ProgramCache } from './ts-program.js';

/** `codeTools(options)`. */
export interface CodeToolsOptions {
  /** The path authority: only files it lets the tools read are ever in a program (deny by default). */
  policy: FsPolicy;
  /** Default: the real disk (`createNodeFsAccess()`). */
  access?: FsAccess;
  /** A tsconfig whose `compilerOptions` (paths, jsx, module resolution...) the programs use; `extends` is not followed. */
  tsconfigPath?: string;
  /** Most code files per root in one program (default 5000); past it the program is marked truncated. */
  maxFiles?: number;
  /** A root's program and its compiler process are closed after this long without a code call (default 5 minutes). */
  idleCloseMs?: number;
}

/** What every code tool is built from. */
export interface CodeDeps {
  policy: FsPolicy;
  access: FsAccess;
  programs: ProgramCache;
}

export const DEFAULT_MAX_CODE_FILES = 5_000;
/** An idle program's compiler process holds the whole program in memory; it is closed after five minutes unused. */
export const DEFAULT_IDLE_CLOSE_MS = 300_000;
/** Cached answers are kept ten minutes; `validity` (every file's mtime and size) catches every edit before then. */
export const CODE_CACHE_TTL_MS = 600_000;
/** Upper bound on items in one code call. */
export const MAX_CODE_ITEMS = 20;
/** Building a program for a large root takes a while (the compiler runs in its own process). */
export const CODE_TOOL_TIMEOUT_MS = 120_000;
/** Longest signature or line text shown. */
const MAX_LINE_CHARS = 200;

/** A tsconfig's text as JSON: comments and trailing commas (which tsconfig allows) removed outside strings. */
function parseJsonc(text: string): unknown {
  const withoutComments = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, quoted: string | undefined) => quoted ?? '');
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, '$1'));
}

/** The `compilerOptions` of the consumer's tsconfig, read through the policy; none without a path. */
async function readCompilerOptions(params: { policy: FsPolicy; access: FsAccess; tsconfigPath?: string }): Promise<Record<string, unknown>> {
  const { policy, access, tsconfigPath } = params;
  if (tsconfigPath == null) return {};
  const decision = await policy.check({ path: tsconfigPath, permission: 'read', access });
  if (!decision.allowed) throw toolFailure({ category: 'denied', code: decision.code, message: `tsconfigPath: ${decision.message}`, retryable: false });
  const parsed = parseJsonc(new TextDecoder().decode(await access.readFile(decision.canonicalPath))) as { compilerOptions?: Record<string, unknown> };
  return parsed.compilerOptions ?? {};
}

export function resolveCodeDeps(params: { options: CodeToolsOptions; loadTypeScript?: () => Promise<TsModules> }): CodeDeps {
  const { options: { policy, access = createNodeFsAccess(), tsconfigPath, maxFiles = DEFAULT_MAX_CODE_FILES, idleCloseMs = DEFAULT_IDLE_CLOSE_MS }, loadTypeScript = loadInstalledTypeScript } = params;
  let options: Promise<Record<string, unknown>> | undefined;
  const compilerOptions = (): Promise<Record<string, unknown>> => (options ??= readCompilerOptions({ policy, access, ...(tsconfigPath == null ? {} : { tsconfigPath }) }));
  // Whatever the loader throws, the model is told what is missing and how to install it.
  const load = (): Promise<TsModules> => loadTypeScript().catch((error: unknown) => { throw isToolFailure(error) ? error : typescriptUnavailable(error); });
  return { policy, access, programs: createProgramCache({ policy, access, maxFiles, idleCloseMs, compilerOptions, loadTypeScript: load }) };
}

/** The file, checked by the policy, in its root's program; a failure the model can act on otherwise. */
export async function sourceFor(params: { deps: CodeDeps; path: string }): Promise<{ program: CodeProgram; source: TsSourceFile; path: string }> {
  const { deps: { policy, access, programs }, path } = params;
  const decision = await policy.check({ path, permission: 'read', access });
  if (!decision.allowed) throw toolFailure({ category: 'denied', code: decision.code, message: decision.message, retryable: false, ...(decision.suggestion == null ? {} : { suggestion: decision.suggestion }), details: { path } });
  if (!CODE_FILE.test(decision.canonicalPath)) {
    throw toolFailure({ code: 'unsupported_language', message: `'${path}' is not TypeScript or JavaScript; the code tools read .ts, .tsx, .js, .jsx, .mts, .cts, .mjs and .cjs files`, retryable: false, suggestion: 'Use fs_search to find text in other files', details: { path } });
  }
  const program = await programs.programFor(decision.root);
  const compilerPath = program.compilerPath(decision.canonicalPath);
  const source = compilerPath == null ? undefined : await program.project.program.getSourceFile(compilerPath);
  if (source == null) {
    throw toolFailure({ code: 'not_in_project', message: `'${path}' is not in the code index of '${decision.root}' (missing, ignored, too large or past maxFiles)`, retryable: false, suggestion: 'Check the path with fs_list, or use fs_read', details: { path } });
  }
  return { program, source, path: decision.canonicalPath };
}

/** 1-based line of a position. */
export function lineOf(params: { source: TsSourceFile; position: number }): number {
  const { source, position } = params;
  const starts = source.getLineStarts();
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= position) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Text with whitespace runs collapsed, cut to a line's worth. */
export function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_LINE_CHARS ? `${collapsed.slice(0, MAX_LINE_CHARS - 1)}…` : collapsed;
}

/** The text of a 1-based line, trimmed and cut. */
export function lineText(params: { source: TsSourceFile; line: number }): string {
  const { source, line } = params;
  const starts = source.getLineStarts();
  const start = starts[line - 1] ?? 0;
  return oneLine(source.text.slice(start, starts[line] ?? source.text.length));
}
