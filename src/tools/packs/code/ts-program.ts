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
}

export interface ProgramCacheParams {
  policy: FsPolicy;
  access: FsAccess;
  maxFiles: number;
  /** Compiler options from the consumer's tsconfig (`codeTools({ tsconfigPath })`), already read. */
  compilerOptions(): Promise<Record<string, unknown>>;
  loadTypeScript(): Promise<TsModules>;
}

/** Programs per root, kept until a file's mtime or size changes; one build at a time per root. */
export function createProgramCache(params: ProgramCacheParams): ProgramCache {
  const { policy, access, maxFiles, compilerOptions, loadTypeScript } = params;
  const caseSensitive = policy.caseSensitive(access);
  const key = (path: string): string => compilerKey({ path, caseSensitive });
  const built = new Map<string, { program: CodeProgram; api: TsApi }>();
  const building = new Map<string, Promise<CodeProgram>>();

  async function build(params: { root: string; files: CodeFileList }): Promise<CodeProgram> {
    const { root, files } = params;
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
    const project = api.updateSnapshot({ openProjects: [configPath] }).getProjects()[0];
    if (project == null) { api.close(); throw new Error(`The compiler opened no project for '${root}'`); }
    const program: CodeProgram = {
      root, version: files.version, truncated: files.truncated, files, project, syntaxKind: modules.syntaxKind,
      compilerPath: path => (own.has(key(path)) ? (own.get(key(path)) as string).replace(/\\/g, '/') : undefined),
      ownPath: compilerPath => own.get(key(compilerPath)),
    };
    const previous = built.get(key(root));
    built.set(key(root), { program, api });
    previous?.api.close();
    return program;
  }

  async function programFor(root: string): Promise<CodeProgram> {
    const pending = building.get(key(root));
    if (pending != null) return pending;
    const work = (async () => {
      const files = await listCodeFiles({ policy, access, root, maxFiles });
      const cached = built.get(key(root));
      return cached != null && cached.program.version === files.version ? cached.program : build({ root, files });
    })();
    building.set(key(root), work);
    try {
      return await work;
    } finally {
      building.delete(key(root));
    }
  }

  return { programFor, versionOf: async root => (await listCodeFiles({ policy, access, root, maxFiles })).version };
}
