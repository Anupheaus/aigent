import { toolFailure } from '../../tool-failure.js';
import { aliasSitesOf, resolveAlias } from './alias-sites.js';
import type { AliasSite } from './alias-sites.js';
import { lineOf } from './code-shared.js';
import type { CodeDeps } from './code-shared.js';
import { declarationKind, describeDeclaration, field, outlineOf } from './declarations.js';
import type { OutlineSymbol, SyntaxKinds } from './declarations.js';
import type { TsNode, TsSourceFile } from './ts-api.js';
import type { CodeProgram } from './ts-program.js';

/** One place a name is declared. */
export interface Definition {
  name: string;
  path: string;
  line: number;
  endLine: number;
  kind: string;
  signature: string;
  /** The class, interface, enum or namespace it is a member of. */
  containerName?: string;
  exported: boolean;
  /** Re-exports and renamed imports that lead here, with the name they use. */
  reexportedFrom?: { path: string; line: number; as: string }[];
}

/** Outline kinds that are places a name is declared (re-exports and `export default` lines are not). */
const NOT_DEFINITIONS: ReadonlySet<string> = new Set(['re-export', 'export-default']);
const CONTAINERS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'namespace']);

/** The roots to search (all readable roots, or the one under `scope`) and the scope's canonical prefix. */
export async function searchRoots(params: { deps: CodeDeps; scope?: string }): Promise<{ roots: string[]; prefix?: string }> {
  const { deps: { policy, access }, scope } = params;
  if (scope != null) {
    const decision = await policy.check({ path: scope, permission: 'read', access });
    if (!decision.allowed) throw toolFailure({ category: 'denied', code: decision.code, message: `scope: ${decision.message}`, retryable: false, details: { scope } });
    return { roots: [decision.root], prefix: decision.canonicalPath };
  }
  const roots = new Set<string>();
  for (const { path, permissions } of policy.roots) {
    if (!permissions.includes('read')) continue;
    const decision = await policy.check({ path, permission: 'read', access });
    if (decision.allowed) roots.add(decision.root);
  }
  return { roots: [...roots] };
}

function flatten(params: { symbols: OutlineSymbol[]; container?: string }): { symbol: OutlineSymbol; container?: string }[] {
  const { symbols, container } = params;
  return symbols.flatMap(symbol => [{ symbol, ...(container == null ? {} : { container }) }, ...flatten({ symbols: symbol.children, container: symbol.name })]);
}

function containerOf(params: { node: TsNode; kinds: SyntaxKinds }): string | undefined {
  const { node, kinds } = params;
  for (let parent = node.parent; parent != null; parent = parent.parent) {
    const kind = declarationKind({ node: parent, kinds });
    if (kind != null && CONTAINERS.has(kind)) return field<string>(field<TsNode>(parent, 'name'), 'text');
  }
  return undefined;
}

interface ProgramFile {
  program: CodeProgram;
  path: string;
  source: TsSourceFile;
}

/** The program's files, fetched one at a time so the event loop runs between them. */
async function filesOf(program: CodeProgram): Promise<ProgramFile[]> {
  const files: ProgramFile[] = [];
  for (const { path } of program.files.entries) {
    const compilerPath = program.compilerPath(path);
    const source = compilerPath == null ? undefined : await program.project.program.getSourceFile(compilerPath);
    if (source != null) files.push({ program, path, source });
  }
  return files;
}

/** The alias site's targets: an overloaded function resolves to its implementation (the declaration with a body). */
async function targetsOf(params: { program: CodeProgram; site: AliasSite }): Promise<TsNode[]> {
  const targets = await resolveAlias(params);
  const implementations = targets.filter(node => field<TsNode>(node, 'body') != null);
  return targets.length > 1 && implementations.length > 0 ? implementations : targets;
}

/**
 * Every declaration of `name` (exact or other case) in the programs of the roots searched, with the re-exports and
 * renamed imports that lead to each; aliases named `name` resolve to the declaration they finally name.
 */
export async function collectDefinitions(params: { deps: CodeDeps; name: string; scope?: string }): Promise<{ definitions: Definition[]; isIndexTruncated: boolean }> {
  const { deps, name, scope } = params;
  const wanted = name.toLowerCase();
  const { roots, prefix } = await searchRoots({ deps, ...(scope == null ? {} : { scope }) });
  const programs = await Promise.all(roots.map(root => deps.programs.programFor(root)));
  const files: ProgramFile[] = [];
  for (const program of programs) files.push(...await filesOf(program));
  const found = new Map<string, Definition>();
  const keyOf = (definition: Pick<Definition, 'path' | 'line' | 'kind'>): string => `${definition.path}\u0000${definition.line}\u0000${definition.kind}`;
  for (const { program, path, source } of files) {
    for (const { symbol, container } of flatten({ symbols: outlineOf({ node: source, kinds: program.syntaxKind }) })) {
      if (NOT_DEFINITIONS.has(symbol.kind) || symbol.name.toLowerCase() !== wanted) continue;
      const { children: _children, ...shown } = symbol;
      const definition: Definition = { ...shown, path, ...(container == null ? {} : { containerName: container }) };
      found.set(keyOf(definition), definition);
    }
  }
  for (const { program, path, source } of files) {
    for (const site of aliasSitesOf({ source, kinds: program.syntaxKind })) {
      const isNamed = site.name.toLowerCase() === wanted;
      const leadsFromName = site.originalName.toLowerCase() === wanted && (site.isReexport || site.name !== site.originalName);
      if (!isNamed && !leadsFromName) continue;
      for (const node of await targetsOf({ program, site })) {
        const kind = declarationKind({ node, kinds: program.syntaxKind });
        const ownPath = program.ownPath(node.getSourceFile().fileName);
        if (kind == null || ownPath == null) continue;
        const { children: _children, ...shown } = describeDeclaration({ node, kinds: program.syntaxKind, kind });
        const container = containerOf({ node, kinds: program.syntaxKind });
        const key = keyOf({ path: ownPath, line: shown.line, kind });
        const definition = found.get(key) ?? (isNamed ? { ...shown, path: ownPath, ...(container == null ? {} : { containerName: container }) } : undefined);
        if (definition == null) continue;
        found.set(key, definition);
        // A plain import is a usage (see code_references); re-exports and renames are other names for the definition.
        const isRenamed = site.name !== (site.originalName === 'default' ? definition.name : site.originalName);
        if (!site.isReexport && !isRenamed) continue;
        const via = { path, line: lineOf({ source, position: site.nameNode.getStart() }), as: site.name };
        definition.reexportedFrom = [...(definition.reexportedFrom ?? []).filter(({ path: viaPath, line }) => viaPath !== via.path || line !== via.line), via];
      }
    }
  }
  const caseSensitive = deps.policy.caseSensitive(deps.access);
  const isWithin = (path: string): boolean => prefix == null || (caseSensitive ? path.startsWith(prefix) : path.toLowerCase().startsWith(prefix.toLowerCase()));
  const definitions = [...found.values()].filter(({ path }) => isWithin(path));
  return { definitions, isIndexTruncated: programs.some(({ truncated }) => truncated) };
}
