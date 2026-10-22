import type { TsModules, TsNode, TsSourceFile } from './ts-api.js';

/** The compiler's `SyntaxKind` (name to number and number to name). */
export type SyntaxKinds = TsModules['syntaxKind'];
import { lineOf, oneLine } from './code-shared.js';

/** One declaration in a file's outline. */
export interface OutlineSymbol {
  name: string;
  kind: string;
  /** 1-based, from the declaration's first token. */
  line: number;
  endLine: number;
  exported: boolean;
  /** The declaration without its body (one line, cut). */
  signature: string;
  children: OutlineSymbol[];
}

/** Syntax kinds the outline lists, by their compiler name, and the kind it reports. */
const DECLARATION_KINDS: Readonly<Record<string, string>> = {
  FunctionDeclaration: 'function', ClassDeclaration: 'class', InterfaceDeclaration: 'interface', TypeAliasDeclaration: 'type', EnumDeclaration: 'enum',
  ModuleDeclaration: 'namespace', MethodDeclaration: 'method', PropertyDeclaration: 'property', Constructor: 'constructor', GetAccessor: 'getter',
  SetAccessor: 'setter', PropertySignature: 'property', MethodSignature: 'method', EnumMember: 'enum-member', VariableDeclaration: 'variable',
  ExportAssignment: 'export-default', ExportDeclaration: 're-export',
};
/** Kinds whose header ends where their `{` starts. */
const BLOCK_HEADERS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'namespace']);

/** A property of a syntax node by name (the API exposes them as getters; the structural types do not list them all). */
export function field<T>(node: TsNode | undefined, name: string): T | undefined {
  return node == null ? undefined : (node as unknown as Record<string, unknown>)[name] as T | undefined;
}

/** Whether a node is of the named syntax kind (compared by number: several kind names share one, e.g. `FirstStatement`). */
export function isKind(params: { node: TsNode | undefined; kinds: SyntaxKinds; name: string }): boolean {
  const { node, kinds, name } = params;
  return node != null && node.kind === kinds[name];
}

/** The outline kind of a declaration node, or undefined for other nodes. */
export function declarationKind(params: { node: TsNode; kinds: SyntaxKinds }): string | undefined {
  const { node, kinds } = params;
  if (isKind({ node, kinds, name: 'VariableDeclaration' })) {
    // `const` declarations are constants; `let` and `var` are variables.
    const list = node.parent;
    return list != null && node.getSourceFile().text.startsWith('const', list.getStart()) ? 'const' : 'variable';
  }
  return Object.entries(DECLARATION_KINDS).find(([name]) => kinds[name] === node.kind)?.[1];
}

/** Statement lists whose names an export list or `export default <name>` can export. */
const MODULE_SCOPES = ['SourceFile', 'ModuleBlock'];
/** Export-list names per scope node, so outlining a file reads its statements once rather than once per declaration. */
const exportListCache = new WeakMap<TsNode, Set<string>>();

/**
 * The local names a module scope exports by name: `export { a, b as c }` (without `from`), `export default a` and
 * `export = a`. These refer to the scope's own declarations, so a declaration with such a name is exported.
 */
function namesExportedByList(params: { scope: TsNode; kinds: SyntaxKinds }): Set<string> {
  const { scope, kinds } = params;
  const known = exportListCache.get(scope);
  if (known != null) return known;
  const names = new Set<string>();
  exportListCache.set(scope, names);
  for (const statement of field<readonly TsNode[]>(scope, 'statements') ?? []) {
    if (isKind({ node: statement, kinds, name: 'ExportAssignment' })) {
      const expression = field<TsNode>(statement, 'expression');
      if (isKind({ node: expression, kinds, name: 'Identifier' })) names.add(field<string>(expression, 'text') ?? '');
      continue;
    }
    if (!isKind({ node: statement, kinds, name: 'ExportDeclaration' }) || field<TsNode>(statement, 'moduleSpecifier') != null) continue;
    for (const specifier of field<readonly TsNode[]>(field<TsNode>(statement, 'exportClause'), 'elements') ?? []) {
      // `export { local as exported }`: the local name is `propertyName` when renamed.
      const local = field<TsNode>(specifier, 'propertyName') ?? field<TsNode>(specifier, 'name');
      names.add(field<string>(local, 'text') ?? '');
    }
  }
  names.delete('');
  return names;
}

function isExported(params: { node: TsNode; kinds: SyntaxKinds }): boolean {
  const { node, kinds } = params;
  if (isKind({ node, kinds, name: 'ExportAssignment' }) || isKind({ node, kinds, name: 'ExportDeclaration' })) return true;
  const target = isKind({ node, kinds, name: 'VariableDeclaration' }) ? node.parent?.parent : node;
  const modifiers = field<readonly TsNode[]>(target, 'modifiers') ?? [];
  if (modifiers.some(modifier => isKind({ node: modifier, kinds, name: 'ExportKeyword' }))) return true;
  const scope = target?.parent;
  if (scope == null || !MODULE_SCOPES.some(name => isKind({ node: scope, kinds, name }))) return false;
  const name = field<string>(field<TsNode>(node, 'name'), 'text');
  return name != null && namesExportedByList({ scope, kinds }).has(name);
}

function nameOf(params: { node: TsNode; kinds: SyntaxKinds; kind: string }): string {
  const { node, kind } = params;
  if (kind === 'constructor') return 'constructor';
  if (kind === 'export-default') return 'default';
  if (kind === 're-export') {
    const elements = field<readonly TsNode[]>(field<TsNode>(node, 'exportClause'), 'elements');
    return elements == null ? '*' : elements.map(element => field<string>(field<TsNode>(element, 'name'), 'text') ?? '').join(', ');
  }
  const name = field<TsNode>(node, 'name');
  return field<string>(name, 'text') ?? (name == null ? 'default' : oneLine(node.getSourceFile().text.slice(name.getStart(), name.end)));
}

function signatureOf(params: { node: TsNode; kind: string; source: TsSourceFile }): string {
  const { node, kind, source } = params;
  const start = node.getStart();
  const body = field<TsNode>(node, 'body');
  let end = node.end;
  if (body != null && !BLOCK_HEADERS.has(kind)) end = body.pos;
  if (BLOCK_HEADERS.has(kind)) { const brace = source.text.indexOf('{', start); if (brace !== -1 && brace < node.end) end = brace; }
  return oneLine(source.text.slice(start, end).replace(/[;,]\s*$/, ''));
}

/** One declaration node as the outline and the symbol search show it (children not included). */
export function describeDeclaration(params: { node: TsNode; kinds: SyntaxKinds; kind: string }): OutlineSymbol {
  const { node, kinds, kind } = params;
  const source = node.getSourceFile();
  const target = kind === 'const' || kind === 'variable' ? node.parent?.parent ?? node : node;
  return {
    name: nameOf({ node, kinds, kind }), kind, line: lineOf({ source, position: node.getStart() }), endLine: lineOf({ source, position: Math.max(node.getStart(), node.end - 1) }),
    exported: isExported({ node, kinds }), signature: kind === 'const' || kind === 'variable' ? signatureOf({ node: target, kind, source }) : signatureOf({ node, kind, source }), children: [],
  };
}

/** The declarations among a node's children, each with its own (members of classes, interfaces, enums, namespaces). */
export function outlineOf(params: { node: TsNode; kinds: SyntaxKinds }): OutlineSymbol[] {
  const { node, kinds } = params;
  const symbols: OutlineSymbol[] = [];
  node.forEachChild(child => {
    if (isKind({ node: child, kinds, name: 'VariableStatement' })) {
      const declarations = field<readonly TsNode[]>(field<TsNode>(child, 'declarationList'), 'declarations') ?? [];
      for (const declaration of declarations) symbols.push(describeDeclaration({ node: declaration, kinds, kind: declarationKind({ node: declaration, kinds }) ?? 'variable' }));
      return undefined;
    }
    if (isKind({ node: child, kinds, name: 'ModuleBlock' })) { symbols.push(...outlineOf({ node: child, kinds })); return undefined; }
    const kind = declarationKind({ node: child, kinds });
    if (kind == null) return undefined;
    const symbol = describeDeclaration({ node: child, kinds, kind });
    if (BLOCK_HEADERS.has(kind)) symbol.children = outlineOf({ node: child, kinds });
    symbols.push(symbol);
    return undefined;
  });
  return symbols;
}
