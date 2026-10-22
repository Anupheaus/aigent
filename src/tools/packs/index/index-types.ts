import type { FsAccess } from '../../../security/fs-access.js';
import type { FsPolicy } from '../../../security/fs-policy-types.js';
import type { Store } from '../../../store/store-types.js';

/** Deterministic classification tags (heuristics over code with comments and strings removed). */
export const FILE_TAGS = [
  'react-component', 'hook', 'provider', 'theme-definition', 'theme-reexport', 'api-route', 'api-handler', 'data-access', 'config', 'test', 'story', 'mock',
  'schema', 'personal-data-fields', 'renders-customer-data', 'gdpr-consent', 'gdpr-deletion', 'gdpr-export', 'gdpr-retention',
] as const;

export type FileTag = typeof FILE_TAGS[number];

/** A name an import binds: `imported` from the module (`default`, `*` for a namespace) as `local` here (the exported name, for a re-export). */
export interface CardBinding {
  imported: string;
  local: string;
}

/** One import of a file: its specifier, the names it brings in and the indexed file it resolves to. */
export interface CardImport {
  specifier: string;
  /** Names it brings in (the original names of an import; the exported names of a re-export). */
  names: string[];
  bindings: CardBinding[];
  /** The whole module is reachable (a namespace or dynamic import, `require`, `export *`), not only `bindings`. */
  isWholeModule: boolean;
  resolved?: string;
  isReexport: boolean;
}

/** A route registration in code (`router.get('/x', auth, handler)`). */
export interface CardRoute {
  /** The receiver's name in this file. */
  router: string;
  method: string;
  /** The path as registered (before any mount prefix). */
  path: string;
  /** The last argument when it is a name (middleware before it is skipped); empty for an inline handler. */
  handler: string;
}

/** A `receiver.use([path,] ...names)` call: the names it mounts under the path. */
export interface CardMount {
  receiver: string;
  /** The mount path; empty when none was given. */
  path: string;
  /** Arguments that are plain names (routers, or middleware, which mounts no routes). */
  routers: string[];
}

/** A route that is served: registered on a router reachable from an app through mounts (or on the app itself). */
export interface LiveRoute {
  method: string;
  /** The served path: mount prefixes joined with the registered path. */
  path: string;
  registeredPath: string;
  router: string;
  handler: string;
}

/** What the index knows about one file: its content facts (cached by content hash and language) and its path facts. */
export interface FileCard {
  /** Relative to the indexed root, `/` separated. */
  path: string;
  language: string;
  size: number;
  /** sha256 of the content. */
  hash: string;
  /** The leading comment or document title, when there is one. */
  purpose?: string;
  /** Exported names (declared or re-exported). */
  exports: string[];
  /** Exported functions declared here (declarations and arrow constants). */
  functions: string[];
  /** Top-level declarations. */
  symbols: string[];
  imports: CardImport[];
  /** Identifiers used in code (not comments or strings), for usage questions. */
  identifiers: string[];
  routes: CardRoute[];
  /** `.use(...)` calls. */
  mounts: CardMount[];
  /** Variables created by a router factory (`Router()`, `express.Router()`, `createRouter()`). */
  routers: string[];
  /** The name in `export default name;`, when there is one. */
  defaultExport?: string;
  tags: FileTag[];
}

/** What a file's bytes say for its language: a card without the path, size, hash and path-given tags. */
export interface ContentFacts extends Omit<FileCard, 'path' | 'language' | 'size' | 'hash' | 'tags'> {
  /** Tags the code gives a file that is not test material (dropped for tests, mocks and stories). */
  contentTags: FileTag[];
}

/** A card with what only the whole repository can tell: who imports it, and which of its exports nobody else uses. */
export interface IndexedFile extends FileCard {
  importers: string[];
  /** Exported functions no other file imports, re-exports or reaches through a whole-module import. */
  unusedExports: string[];
  /** Routes registered here that are served (with their mount prefixes). */
  liveRoutes: LiveRoute[];
}

/** The index at one moment: every card, a version that changes with any file, and what the last refresh did. */
export interface IndexSnapshot {
  root: string;
  version: string;
  files: Map<string, IndexedFile>;
  /** Text files built into cards by the last refresh (new or changed content); the rest were reused. */
  processed: string[];
  /** Entries left out, by reason (ignored, denied, binary, tooLarge, unreadable...); only reasons that occurred. */
  skipped: Record<string, number>;
  /** Files that could not be read even after a retry (a sample), so answers may miss them. */
  unreadable: string[];
}

/** `indexTools(options)` and `createRepoIndex(options)`. */
export interface IndexToolsOptions {
  /** The path authority: the index covers its first root (or `root`), reading only what it allows. */
  policy: FsPolicy;
  /** Default: the real disk. */
  access?: FsAccess;
  /** Absolute directory to index (must be allowed by the policy); default the policy's first root. */
  root?: string;
  /** Where cards are kept by content hash, shared by every index over the same store (collection `repo-index`). */
  store?: Store;
}
