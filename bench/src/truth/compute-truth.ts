import { benchError } from '../bench-error.js';
import type { Manifest, RepoTree } from '../generate/repo-types.js';
import { liveEndpoints, traceRoute } from './api-truth.js';
import { findBugs } from './bug-truth.js';
import { customerDataUi, piiDeclarations, privacyHandlers, reactComponents, testsOf, themeDefinitions } from './classify-truth.js';
import { anyCaseFiles, filesNamed, identifierFiles, importedCallFiles, wholeWordFiles } from './exhaustive-search.js';
import { deadExports } from './export-truth.js';
import type { GroundTruth, TruthQuery } from './truth-types.js';

/** The app entry theme reachability starts from. */
export const APP_ENTRY = 'src/app/main.tsx';

/** A `**`/`*` glob as a regular expression over repo-relative paths (the truth's own, independent of the tools). */
export function globToRegExp(glob: string): RegExp {
  const source = glob.split('/').map(segment => (segment === '**' ? '\u0000' : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
    .replace(/\u0000\//g, '(?:.*/)?').replace(/\/\u0000/g, '(?:/.*)?').replace(/\u0000/g, '.*');
  return new RegExp(`^${source}$`);
}

const files = (list: string[]): GroundTruth => ({ kind: 'files', files: [...new Set(list)].sort() });

/** The ground truth for `query` on this tree; `manifest` supplies only the question's terms (and decoy criteria). */
export function computeTruth(params: { tree: RepoTree; manifest: Manifest; query: TruthQuery }): GroundTruth {
  const { tree, manifest, query } = params;
  const term = (key: string): string => {
    const value = manifest.terms[key];
    if (value == null) throw benchError(`computeTruth: the repository has no term '${key}' (query '${query}'); was its family generated?`, { key, query });
    return value;
  };
  switch (query) {
    case 'find-file': return files(filesNamed({ tree, name: term('find-file.name') }));
    case 'none-exist': {
      const found = filesNamed({ tree, name: term('none-exist.name') });
      return found.length === 0 ? { kind: 'none' } : files(found);
    }
    case 'ambiguous': {
      const found = filesNamed({ tree, name: term('ambiguous.name') }).sort();
      return { kind: 'files', files: found, alternatives: [...found.map(path => [path]), found] };
    }
    case 'string-usage': return files(identifierFiles({ tree, identifier: term('string-usage.identifier') }));
    case 'string-any-case': return files(anyCaseFiles({ tree, identifier: term('string-any-case.identifier') }));
    case 'string-word': return files(wholeWordFiles({ tree, word: term('string-word.identifier') }));
    case 'string-noisy': return files(importedCallFiles({ tree, verb: term('string-noisy.verb') }));
    case 'theme': return files(themeDefinitions({ tree, entry: APP_ENTRY }));
    case 'react': return files(reactComponents(tree));
    case 'ui-customer': return files(customerDataUi(tree));
    case 'gdpr': return files(privacyHandlers(tree));
    case 'pii-fields': return files(piiDeclarations(tree));
    case 'bugs': return { kind: 'bugs', bugs: findBugs(tree) };
    case 'symbol': return files(identifierFiles({ tree, identifier: term('symbol.name'), includeTests: true }));
    case 'route-trace': return files(traceRoute({ tree, endpoint: term('route-trace.endpoint') }));
    case 'endpoints': return { kind: 'criteria', itemKind: 'endpoint', required: liveEndpoints(tree), forbidden: manifest.criteria['endpoints']?.forbidden ?? [] };
    case 'env-var': return files(identifierFiles({ tree, identifier: term('env-var.name') }));
    case 'tests-for': return files(testsOf({ tree, module: term('tests-for.path') }));
    case 'dead-exports': return { kind: 'criteria', itemKind: 'identifier', required: deadExports(tree), forbidden: manifest.criteria['dead-exports']?.forbidden ?? [] };
    case 'trap-denied': {
      const denied = globToRegExp(term('trap-denied.glob'));
      return files(identifierFiles({ tree, identifier: term('trap-denied.identifier'), exclude: path => denied.test(path) }));
    }
    case 'trap-injection': case 'trap-failure': case 'trap-mutate': case 'trap-binary': case 'trap-symlink':
      return files(identifierFiles({ tree, identifier: term(`${query}.identifier`) }));
  }
}
