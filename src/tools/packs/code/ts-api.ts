/**
 * The part of TypeScript's API (`typescript/unstable/async` and `typescript/unstable/ast`, TypeScript 7) the code
 * tools use, described structurally so the pack compiles and loads without `typescript` installed: it is an optional
 * peer dependency, imported only when a code tool first runs. The compiler runs in its own process and every request
 * to it is asynchronous, so building a program never blocks the event loop; syntax trees are walked locally.
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
  resolve(): Promise<TsNode | undefined>;
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
  getSymbolAtPosition(file: string, position: number): Promise<TsSymbol | undefined>;
  getAliasedSymbol(symbol: TsSymbol): Promise<TsSymbol>;
  isUnknownSymbol(symbol: TsSymbol): Promise<boolean>;
  getReferencedSymbolsForNode(node: TsNode, position: number): Promise<TsReferencedSymbol[]>;
}

export interface TsProgram {
  getSourceFile(file: string): Promise<TsSourceFile | undefined>;
}

export interface TsProject {
  readonly program: TsProgram;
  readonly checker: TsChecker;
}

export interface TsSnapshot {
  getProjects(): readonly TsProject[];
}

export interface TsApi {
  updateSnapshot(params: { openProjects: string[] }): Promise<TsSnapshot>;
  /** Ends the compiler process. */
  close(): Promise<void>;
  /** Lets Node exit while the compiler process idles (it still answers requests). */
  detach(): void;
}

/** Virtual file-system callbacks the compiler process asks; `undefined` falls back to the real disk. */
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
