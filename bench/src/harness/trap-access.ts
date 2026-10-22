import type { FsAccess, FsFileHandle } from '../../../src/tools/packs/fs/index.js';

/** An I/O failure as Node reports one (`code: 'EIO'`), so the tools treat it as a disk error. */
function ioError(path: string): Error {
  return Object.assign(new Error(`EIO: injected read failure '${path}'`), { code: 'EIO' });
}

/** The first `failures` reads (open or readFile) of `path` fail with EIO; later reads succeed (a transient fault). */
export function withFailingReads(params: { access: FsAccess; path: string; failures?: number }): FsAccess {
  const { access, path, failures = 1 } = params;
  let left = failures;
  const guard = (target: string): void => {
    if (target !== path || left <= 0) return;
    left -= 1;
    throw ioError(target);
  };
  return {
    ...access,
    readFile: async target => { guard(target); return access.readFile(target); },
    open: async target => { guard(target); return access.open(target); },
  };
}

/** A handle over fixed bytes, keeping the real file's `stat` (its identity) for the verification checks. */
function bytesHandle(params: { bytes: Uint8Array; real: FsFileHandle }): FsFileHandle {
  const { bytes, real } = params;
  const stat = real.stat?.bind(real);
  return {
    read: async ({ offset, length }) => bytes.slice(offset, offset + length),
    ...(stat == null ? {} : { stat }),
    close: () => real.close(),
  };
}

/** Every read of `path` sees a new revision: a header line naming the revision, then the original text. */
export function withMutatingReads(params: { access: FsAccess; path: string }): FsAccess {
  const { access, path } = params;
  let revision = 0;
  const mutate = (original: Uint8Array): Uint8Array => {
    revision += 1;
    const header = new TextEncoder().encode(`// regenerated, revision ${revision}\n`);
    const merged = new Uint8Array(header.length + original.length);
    merged.set(header, 0);
    merged.set(original, header.length);
    return merged;
  };
  return {
    ...access,
    readFile: async target => (target === path ? mutate(await access.readFile(target)) : access.readFile(target)),
    open: async target => {
      const real = await access.open(target);
      return target === path ? bytesHandle({ bytes: mutate(await access.readFile(target)), real }) : real;
    },
  };
}
