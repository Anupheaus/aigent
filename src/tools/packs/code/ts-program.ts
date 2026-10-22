import type { FsAccess } from '../../../security/fs-access.js';
import type { FsPolicy } from '../../../security/fs-policy-types.js';
import { listCodeFiles } from './code-files.js';
import type { CodeFileList } from './code-files.js';
import type { TsApi, TsModules, TsProject } from './ts-api.js';
import { compilerKey, createVirtualFs } from './virtual-fs.js';

/** The generated tsconfig: it exists only in the compiler's virtual disk, next to the root's files. */
const CONFIG_NAME = '__aigent_tsconfig__.json';
/** Compiler options the tools always set: analysis only, any JS, no checking of libraries. */
const FORCED_OPTIONS = { noEmit: true, skipLibCheck: true, allowJs: true, checkJs: false, allowImportingTsExtensions: true };
const DEFAULT_OPTIONS = { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve', strict: false };
/** A timer that only keeps Node alive while code calls are in flight; it never needs to fire. */
const KEEP_ALIVE_MS = 3_600_000;

/** One root's program, built from the files the policy allowed; rebuilt when any of them changes. */
export interface CodeProgram {
  root: string;
  version: string;
  truncated: boolean;
  files: CodeFileList;
  project: TsProject;
  syntaxKind: TsModules['syntaxKind'];
  /** The file's path as the compiler spells it, when the file is in the program. */
  compilerPath(path: string): string | undefined;
  /** A compiler path (any case) back to the file's own path, or undefined for files outside the program (libraries). */
  ownPath(compilerPathOrHandle: string): string | undefined;
}

export interface ProgramCache {
  programFor(root: string): Promise<CodeProgram>;
  /** The root's current file-version token (cheap: a walk and stats, no compiler). */
  versionOf(root: string): Promise<string>;
  /**
   * Runs one code call. Compiler processes are detached from the event loop while idle (so the process can exit), so
   * this keeps Node alive until the call's requests are answered.
   */
  hold<T>(work: () => Promise<T>): Promise<T>;
  /** Closes every compiler process, built or still building; a later call builds its program again. */
  dispose(): Promise<void>;
}

export interface ProgramCacheParams {
  policy: FsPolicy;
  access: FsAccess;
  maxFiles: number;
  /** A root's program (and its compiler process) is closed after this long without a code call. */
  idleCloseMs: number;
  /** Compiler options from the consumer's tsconfig (`codeTools({ tsconfigPath })`), already read. */
  compilerOptions(): Promise<Record<string, unknown>>;
  loadTypeScript(): Promise<TsModules>;
}

interface BuiltProgram {
  program: CodeProgram;
  api: TsApi;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Programs per root, kept until a file's mtime or size changes or the root idles; one build at a time per root. */
export function createProgramCache(params: ProgramCacheParams): ProgramCache {
  const { policy, access, maxFiles, idleCloseMs, compilerOptions, loadTypeScript } = params;
  const caseSensitive = policy.caseSensitive(access);
  const key = (path: string): string => compilerKey({ path, caseSensitive });
  const built = new Map<string, BuiltProgram>();
  const building = new Map<string, Promise<CodeProgram>>();
  /** Every compiler process not yet closed, including builds in flight, so `dispose` reaches them all. */
  const open = new Set<TsApi>();
  let calls = 0;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const close = (api: TsApi): Promise<void> => {
    open.delete(api);
    // A process that already ended has nothing left to close.
    return api.close().catch(() => undefined);
  };

  const scheduleIdleClose = (rootKey: string): void => {
    const entry = built.get(rootKey);
    if (entry == null) return;
    if (entry.idleTimer != null) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      // A call still in flight may be using it: look again later.
      if (calls > 0) { scheduleIdleClose(rootKey); return; }
      if (built.get(rootKey) !== entry) return;
      built.delete(rootKey);
      void close(entry.api);
    }, idleCloseMs);
    entry.idleTimer.unref();
  };

  async function build(buildParams: { root: string; files: CodeFileList }): Promise<CodeProgram> {
    const { root, files } = buildParams;
    const modules = await loadTypeScript();
    const texts = new Map<string, string>();
    const own = new Map<string, string>();
    const decoder = new TextDecoder('utf-8');
    for (const { path } of files.entries) {
      const text = await access.readFile(path).then(bytes => decoder.decode(bytes), () => undefined);
      if (text == null) { files.skipped.add('unreadable', path); continue; }
      texts.set(key(path), text);
      own.set(key(path), path);
    }
    const rootForward = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const configPath = `${rootForward}/${CONFIG_NAME}`;
    const config = { compilerOptions: { ...DEFAULT_OPTIONS, ...await compilerOptions(), ...FORCED_OPTIONS }, files: [...own.values()].map(path => path.replace(/\\/g, '/')) };
    const fs = createVirtualFs({ files: texts, extra: new Map([[key(configPath), JSON.stringify(config)]]), caseSensitive });
    const api = modules.createApi({ cwd: rootForward, fs });
    open.add(api);
    let project: TsProject | undefined;
    try {
      project = (await api.updateSnapshot({ openProjects: [configPath] })).getProjects()[0];
    } catch (error) {
      await close(api);
      throw error;
    }
    if (project == null) { await close(api); throw new Error(`The compiler opened no project for '${root}'`); }
    // The process is running now; from here only calls in flight (`hold`) keep Node alive.
    api.detach();
    const program: CodeProgram = {
      root, version: files.version, truncated: files.truncated, files, project, syntaxKind: modules.syntaxKind,
      compilerPath: path => (own.has(key(path)) ? (own.get(key(path)) as string).replace(/\\/g, '/') : undefined),
      ownPath: compilerPath => own.get(key(compilerPath)),
    };
    // Disposed while building: the process was closed, so the program is not kept.
    if (!open.has(api)) return program;
    const previous = built.get(key(root));
    if (previous?.idleTimer != null) clearTimeout(previous.idleTimer);
    built.set(key(root), { program, api });
    if (previous != null) void close(previous.api);
    return program;
  }

  async function programFor(root: string): Promise<CodeProgram> {
    const rootKey = key(root);
    const pending = building.get(rootKey);
    if (pending != null) return pending;
    const work = (async () => {
      const files = await listCodeFiles({ policy, access, root, maxFiles });
      const cached = built.get(rootKey);
      return cached != null && cached.program.version === files.version ? cached.program : build({ root, files });
    })();
    building.set(rootKey, work);
    try {
      return await work;
    } finally {
      building.delete(rootKey);
      scheduleIdleClose(rootKey);
    }
  }

  async function hold<T>(work: () => Promise<T>): Promise<T> {
    calls += 1;
    keepAlive ??= setInterval(() => undefined, KEEP_ALIVE_MS);
    try {
      return await work();
    } finally {
      calls -= 1;
      if (calls === 0 && keepAlive != null) { clearInterval(keepAlive); keepAlive = undefined; }
    }
  }

  async function dispose(): Promise<void> {
    for (const { idleTimer } of built.values()) if (idleTimer != null) clearTimeout(idleTimer);
    built.clear();
    await Promise.all([...open].map(close));
  }

  return { programFor, versionOf: async root => (await listCodeFiles({ policy, access, root, maxFiles })).version, hold, dispose };
}
