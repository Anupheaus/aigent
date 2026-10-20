import { createAigentError } from '../core/aigent-error.js';
import type { AigentError } from '../core/aigent-error.js';

/** Path flavour: separators, roots, drive letters and reserved names. */
export type PathPlatform = 'posix' | 'win32';

export type FsEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FsStat {
  type: FsEntryType;
  /** Bytes (0 for directories). */
  size: number;
  /** Last modification, epoch ms. */
  mtimeMs: number;
}

export interface FsDirEntry {
  name: string;
  type: FsEntryType;
}

/** An open file for ranged reads (`FsAccess.open`); always `close()` it. */
export interface FsFileHandle {
  /** Up to `length` bytes from byte `offset` (fewer at the end of the file). */
  read(range: { offset: number; length: number }): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** `FsAccess.writeFile`. */
export interface FsWriteRequest {
  path: string;
  data: Uint8Array;
  /** Fail with `EEXIST` instead of replacing an existing file (an atomic create). */
  exclusive?: boolean;
}

/**
 * Everything the filesystem tools do to a disk, so tests can run against a real temp directory (`createNodeFsAccess`)
 * or a fake (`createMemoryFsAccess`). Paths are absolute and already canonical (see `FsPolicy`); failures carry a
 * Node-style code (`ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `ELOOP`), read by `fsErrorCode`.
 */
export interface FsAccess {
  platform: PathPlatform;
  /** Follows symlinks. */
  stat(path: string): Promise<FsStat>;
  /** Describes a symlink itself. */
  lstat(path: string): Promise<FsStat>;
  /** The path with every symlink (and, on Windows, short name and junction) resolved. */
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  open(path: string): Promise<FsFileHandle>;
  writeFile(request: FsWriteRequest): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Entries sorted by name. */
  readdir(path: string): Promise<FsDirEntry[]>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
}

/** Node-style error codes the tools act on. */
export type FsErrorCode = 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'ELOOP' | 'EPERM' | 'EACCES';

/** A file-system failure as the fakes raise it: an `AigentError` with `details.fsCode`. */
export function fsError(params: { code: FsErrorCode; path: string; message: string }): AigentError {
  const { code, path, message } = params;
  return createAigentError({ code: 'invalid_input', message: `${code}: ${message} '${path}'`, details: { fsCode: code, path } });
}

/** The Node-style code of a file-system failure (Node's own `code`, or a fake's `details.fsCode`). */
export function fsErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, details } = error as { code?: unknown; details?: { fsCode?: unknown } };
  if (typeof details?.fsCode === 'string') return details.fsCode;
  return typeof code === 'string' && code.startsWith('E') ? code : undefined;
}
