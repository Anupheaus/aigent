/**
 * The part of TypeScript's API (`typescript/unstable/sync` and `typescript/unstable/ast`, TypeScript 7) the code
 * tools use, described structurally so the pack compiles and loads without `typescript` installed: it is an optional
 * peer dependency, imported only when a code tool first runs.
 */

/** A syntax node. Positions are UTF-16 offsets into the file's text; `pos` includes leading trivia, `getStart()` not. */
export interface TsNode {
  readonly kind: number;
  readonly pos: number;
  readonly end: number;
  readonly parent?: TsNode;
  forEachChild<T>(visitor: (node: TsNode) => T): T | undefined;
  getStart(): number;
  getSourceFile(): TsSourceFile;
}

export interface TsSourceFile extends TsNode {
  readonly text: string;
  readonly fileName: string;
  getLineStarts(): readonly number[];
}

/** A reference to a node, resolved on demand (paths are as the compiler spells them: lower case on Windows). */
export interface TsNodeHandle {
  readonly kind: number;
  readonly path: string;
  resolve(): TsNode | undefined;
}

export interface TsSymbol {
  readonly id: number;
  readonly name: string;
  readonly flags: number;
  readonly declarations: readonly TsNodeHandle[];
}

export interface TsReferencedSymbol {
  definition: TsNodeHandle;
  references: TsNodeHandle[];
}

export interface TsChecker {
  getSymbolAtPosition(file: string, position: number): TsSymbol | undefined;
  getAliasedSymbol(symbol: TsSymbol): TsSymbol;
  isUnknownSymbol(symbol: TsSymbol): boolean;
  getReferencedSymbolsForNode(node: TsNode, position: number): TsReferencedSymbol[];
}

export interface TsProgram {
  getSourceFile(file: string): TsSourceFile | undefined;
  getSourceFileNames(): readonly string[];
}

export interface TsProject {
  readonly program: TsProgram;
  readonly checker: TsChecker;
}

export interface TsSnapshot {
  getProjects(): readonly TsProject[];
  dispose(): void;
}

export interface TsApi {
  updateSnapshot(params: { openProjects: string[] }): TsSnapshot;
  close(): void;
}

/** Virtual file-system callbacks the compiler process asks (synchronously); `undefined` falls back to the real disk. */
export interface TsFileSystem {
  readFile(fileName: string): string | null | undefined;
  fileExists(fileName: string): boolean | undefined;
  directoryExists(directoryName: string): boolean | undefined;
  getAccessibleEntries(directoryName: string): { files: string[]; directories: string[] } | undefined;
  realpath(path: string): string | undefined;
}

/** What the loader hands the pack. */
export interface TsModules {
  createApi(params: { cwd: string; fs: TsFileSystem }): TsApi;
  /** `SyntaxKind`: name to number (and number to name). */
  syntaxKind: Readonly<Record<string, number | string>>;
}
