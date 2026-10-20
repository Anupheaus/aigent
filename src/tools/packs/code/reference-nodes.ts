import { toolFailure } from '../../tool-failure.js';
import { declarationKind, field, isKind } from './declarations.js';
import type { SyntaxKinds } from './declarations.js';
import type { TsNode, TsSourceFile } from './ts-api.js';

/** How a reference uses its symbol. */
export type UsageKind = 'definition' | 'import' | 'call' | 'type-ref' | 'other';

const IMPORT_PARENTS = ['ImportSpecifier', 'ImportClause', 'NamespaceImport', 'ImportEqualsDeclaration', 'ExportSpecifier'];
const CALL_PARENTS = ['CallExpression', 'NewExpression'];
const TYPE_PARENTS = ['TypeReference', 'ExpressionWithTypeArguments', 'TypeQuery', 'QualifiedName', 'HeritageClause'];
const NAME_KINDS = ['Identifier', 'PrivateIdentifier'];

function same(left: TsNode | undefined, right: TsNode | undefined): boolean {
  return left != null && right != null && left.pos === right.pos && left.end === right.end;
}

function isAnyKind(params: { node: TsNode | undefined; kinds: SyntaxKinds; names: string[] }): boolean {
  const { node, kinds, names } = params;
  return names.some(name => isKind({ node, kinds, name }));
}

/** The innermost name (identifier) at `position`, if the position is on one. */
export function nameAt(params: { source: TsSourceFile; position: number; kinds: SyntaxKinds }): TsNode | undefined {
  const { source, position, kinds } = params;
  let current: TsNode = source;
  for (;;) {
    const inner: TsNode | undefined = current.forEachChild(child => (child.getStart() <= position && position < child.end ? child : undefined));
    if (inner == null) break;
    current = inner;
  }
  return isAnyKind({ node: current, kinds, names: NAME_KINDS }) ? current : undefined;
}

/** The first declaration name `symbol` in the file (else its first occurrence as a name). */
function firstName(params: { source: TsSourceFile; symbol: string; kinds: SyntaxKinds }): TsNode | undefined {
  const { source, symbol, kinds } = params;
  let declared: TsNode | undefined;
  let any: TsNode | undefined;
  const visit = (node: TsNode): true | undefined => {
    if (isAnyKind({ node, kinds, names: NAME_KINDS }) && field<string>(node, 'text') === symbol) {
      any ??= node;
      if (node.parent != null && declarationKind({ node: node.parent, kinds }) != null && same(field<TsNode>(node.parent, 'name'), node)) { declared = node; return true; }
    }
    return node.forEachChild(visit);
  };
  visit(source);
  return declared ?? any;
}

/** The name an item points at: a 1-based line (and character), a symbol name in the file, or both. */
export function targetName(params: { source: TsSourceFile; kinds: SyntaxKinds; line?: number; character?: number; symbol?: string }): TsNode {
  const { source, kinds, line, character, symbol } = params;
  if (line == null && symbol == null) throw toolFailure({ code: 'invalid_target', message: 'Give the line (and character) of the name, or its symbol name', retryable: true });
  let node: TsNode | undefined;
  if (line == null) {
    node = firstName({ source, symbol: symbol as string, kinds });
  } else {
    const starts = source.getLineStarts();
    const start = starts[line - 1];
    if (start == null) throw toolFailure({ code: 'invalid_position', message: `Line ${line} is past the end of the file (${starts.length} lines)`, retryable: true });
    const lineEnd = starts[line] ?? source.text.length;
    const offset = character != null ? character - 1 : symbol != null ? source.text.slice(start, lineEnd).indexOf(symbol) : source.text.slice(start, lineEnd).search(/[A-Za-z_$#]/);
    node = offset < 0 ? undefined : nameAt({ source, position: start + offset, kinds });
  }
  if (node == null) {
    throw toolFailure({ code: 'no_symbol_at_position', message: `No name found ${line == null ? `called '${symbol ?? ''}'` : `at line ${line}${character == null ? '' : `, character ${character}`}`}`, retryable: true, suggestion: 'Point at the name itself (its line and 1-based character), or give the symbol name' });
  }
  return node;
}

/** How the name at a reference is used, from its place in the syntax tree. */
export function usageKind(params: { node: TsNode; kinds: SyntaxKinds }): UsageKind {
  const { node, kinds } = params;
  const parent = node.parent;
  if (parent == null) return 'other';
  const declared = declarationKind({ node: parent, kinds });
  if (declared != null && declared !== 're-export' && declared !== 'export-default' && same(field<TsNode>(parent, 'name'), node)) return 'definition';
  if (isAnyKind({ node: parent, kinds, names: IMPORT_PARENTS })) return 'import';
  if (isAnyKind({ node: parent, kinds, names: CALL_PARENTS }) && same(field<TsNode>(parent, 'expression'), node)) return 'call';
  const grandparent = parent.parent;
  if (isKind({ node: parent, kinds, name: 'PropertyAccessExpression' }) && same(field<TsNode>(parent, 'name'), node) && isAnyKind({ node: grandparent, kinds, names: CALL_PARENTS }) && same(field<TsNode>(grandparent, 'expression'), parent)) return 'call';
  if (isAnyKind({ node: parent, kinds, names: TYPE_PARENTS })) return 'type-ref';
  return 'other';
}
