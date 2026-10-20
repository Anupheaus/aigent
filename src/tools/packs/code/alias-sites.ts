import type { TsNode, TsSourceFile, TsSymbol } from './ts-api.js';
import { field, isKind } from './declarations.js';
import type { SyntaxKinds } from './declarations.js';
import type { CodeProgram } from './ts-program.js';

/** An import or re-export that names a declaration from elsewhere, possibly under another name. */
export interface AliasSite {
  /** The local (or exported) name node. */
  nameNode: TsNode;
  name: string;
  /** The name it imports or re-exports (`scale` in `scale as resize`); the same as `name` when not renamed. */
  originalName: string;
  isReexport: boolean;
}

function textOf(node: TsNode | undefined): string | undefined {
  return field<string>(node, 'text');
}

/** Every import binding and re-export specifier of a file, in order. */
export function aliasSitesOf(params: { source: TsSourceFile; kinds: SyntaxKinds }): AliasSite[] {
  const { source, kinds } = params;
  const sites: AliasSite[] = [];
  const addSpecifiers = (bindings: TsNode | undefined, isReexport: boolean): void => {
    for (const element of field<readonly TsNode[]>(bindings, 'elements') ?? []) {
      const nameNode = field<TsNode>(element, 'name');
      const name = textOf(nameNode);
      if (nameNode == null || name == null) continue;
      sites.push({ nameNode, name, originalName: textOf(field<TsNode>(element, 'propertyName')) ?? name, isReexport });
    }
  };
  source.forEachChild(statement => {
    if (isKind({ node: statement, kinds, name: 'ImportDeclaration' })) {
      const clause = field<TsNode>(statement, 'importClause');
      const defaultName = field<TsNode>(clause, 'name');
      const name = textOf(defaultName);
      if (defaultName != null && name != null) sites.push({ nameNode: defaultName, name, originalName: 'default', isReexport: false });
      addSpecifiers(field<TsNode>(clause, 'namedBindings'), false);
    } else if (isKind({ node: statement, kinds, name: 'ExportDeclaration' })) {
      addSpecifiers(field<TsNode>(statement, 'exportClause'), true);
    }
    return undefined;
  });
  return sites;
}

/** Alias symbols carry this flag (`SymbolFlags.Alias`). */
const ALIAS_FLAG = 2_097_152;

/** The declarations an alias site finally names (following re-export chains), inside the program's own files only. */
export function resolveAlias(params: { program: CodeProgram; site: AliasSite }): TsNode[] {
  const { program, site: { nameNode } } = params;
  const { checker } = program.project;
  const source = nameNode.getSourceFile();
  let symbol: TsSymbol | undefined = checker.getSymbolAtPosition(source.fileName, nameNode.getStart());
  if (symbol == null) return [];
  if ((symbol.flags & ALIAS_FLAG) !== 0) symbol = checker.getAliasedSymbol(symbol);
  if (checker.isUnknownSymbol(symbol)) return [];
  return symbol.declarations.flatMap(handle => {
    if (program.ownPath(handle.path) == null) return [];
    const node = handle.resolve();
    return node == null ? [] : [node];
  });
}
