import type { PathPlatform } from './fs-access.js';

/** An absolute path as a root (`/`, `C:\`, `\\server\share\`) and its segments (no `.`, `..` or empty ones). */
export interface PathParts {
  root: string;
  segments: string[];
}

const WIN_DRIVE_ROOT = /^[A-Za-z]:\\/;

export function separatorOf(platform: PathPlatform): string {
  return platform === 'win32' ? '\\' : '/';
}

/** Default case sensitivity of a platform's file systems (Windows and macOS are case-insensitive). */
export function isCaseSensitiveByDefault(platform: PathPlatform): boolean {
  if (platform === 'win32') return false;
  return typeof process === 'undefined' || process.platform !== 'darwin';
}

/** Splits an absolute path written with the platform's separators; undefined when it is not absolute. */
export function splitAbsolute(params: { path: string; platform: PathPlatform }): PathParts | undefined {
  const { path, platform } = params;
  if (platform === 'posix') {
    if (!path.startsWith('/')) return undefined;
    return { root: '/', segments: path.split('/').filter(segment => segment !== '') };
  }
  const normalised = path.replace(/\//g, '\\');
  if (WIN_DRIVE_ROOT.test(normalised)) {
    return { root: `${normalised.slice(0, 2).toUpperCase()}\\`, segments: normalised.slice(3).split('\\').filter(segment => segment !== '') };
  }
  if (normalised.startsWith('\\\\')) {
    const [server = '', share = '', ...segments] = normalised.slice(2).split('\\');
    if (server === '' || share === '') return undefined;
    return { root: `\\\\${server}\\${share}\\`, segments: segments.filter(segment => segment !== '') };
  }
  return undefined;
}

export function joinParts(params: { parts: PathParts; platform: PathPlatform }): string {
  const { parts: { root, segments }, platform } = params;
  return root + segments.join(separatorOf(platform));
}

/** How two paths compare on this file system: lower-cased when it is case-insensitive. */
export function comparable(params: { path: string; caseSensitive: boolean }): string {
  const { path, caseSensitive } = params;
  return caseSensitive ? path : path.toLowerCase();
}
