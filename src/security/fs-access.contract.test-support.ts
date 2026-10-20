import { expect, it } from 'vitest';
import { fsErrorCode } from './fs-access.js';
import type { FsAccess } from './fs-access.js';

/** An access over an empty directory `root`, and how to get rid of it. */
export interface ContractSubject {
  access: FsAccess;
  root: string;
  join(...segments: string[]): string;
  cleanup(): Promise<void>;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(() => undefined, (error: unknown) => fsErrorCode(error) ?? 'no code');
}

/** The behaviour every `FsAccess` shares, so the memory fake stays faithful to the real disk. */
export function fsAccessContract(create: () => Promise<ContractSubject>): void {
  it('writes, reads, stats and lists files and directories', async () => {
    const { access, join, cleanup } = await create();
    try {
      await access.mkdir(join('dir', 'sub'), { recursive: true });
      await access.writeFile({ path: join('dir', 'b.txt'), data: bytes('bee') });
      await access.writeFile({ path: join('dir', 'a.txt'), data: bytes('a\r\nb') });
      expect(text(await access.readFile(join('dir', 'a.txt')))).toBe('a\r\nb');
      expect(await access.stat(join('dir', 'a.txt'))).toMatchObject({ type: 'file', size: 4 });
      expect((await access.stat(join('dir', 'sub'))).type).toBe('directory');
      expect(await access.readdir(join('dir'))).toEqual([{ name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }, { name: 'sub', type: 'directory' }]);
    } finally { await cleanup(); }
  });

  it('reads byte ranges through an open handle', async () => {
    const { access, join, cleanup } = await create();
    try {
      await access.writeFile({ path: join('r.bin'), data: bytes('0123456789') });
      const handle = await access.open(join('r.bin'));
      expect(text(await handle.read({ offset: 3, length: 4 }))).toBe('3456');
      expect(text(await handle.read({ offset: 8, length: 10 }))).toBe('89');
      await handle.close();
    } finally { await cleanup(); }
  });

  it('fails with Node-style codes', async () => {
    const { access, join, cleanup } = await create();
    try {
      await access.writeFile({ path: join('x.txt'), data: bytes('x') });
      expect(await codeOf(access.readFile(join('missing.txt')))).toBe('ENOENT');
      expect(await codeOf(access.writeFile({ path: join('x.txt'), data: bytes('y'), exclusive: true }))).toBe('EEXIST');
      expect(await codeOf(access.writeFile({ path: join('no-dir', 'y.txt'), data: bytes('y') }))).toBe('ENOENT');
      await access.mkdir(join('full'));
      await access.writeFile({ path: join('full', 'f'), data: bytes('f') });
      expect(await codeOf(access.rm(join('full')))).toMatch(/^E/);
    } finally { await cleanup(); }
  });

  it('renames, copies and removes', async () => {
    const { access, join, cleanup } = await create();
    try {
      await access.writeFile({ path: join('a.txt'), data: bytes('A') });
      await access.rename(join('a.txt'), join('b.txt'));
      await access.copyFile(join('b.txt'), join('c.txt'));
      expect(await codeOf(access.stat(join('a.txt')))).toBe('ENOENT');
      expect(text(await access.readFile(join('c.txt')))).toBe('A');
      await access.rm(join('b.txt'));
      await access.mkdir(join('tree', 'deep'), { recursive: true });
      await access.writeFile({ path: join('tree', 'deep', 'f'), data: bytes('f') });
      await access.rm(join('tree'), { recursive: true });
      expect((await access.readdir(join())).map(({ name }) => name)).toEqual(['c.txt']);
    } finally { await cleanup(); }
  });

  it('resolves the canonical path of an existing file through realpath', async () => {
    const { access, join, cleanup } = await create();
    try {
      await access.mkdir(join('d'));
      await access.writeFile({ path: join('d', 'f.txt'), data: bytes('f') });
      expect(await access.realpath(join('d', 'f.txt'))).toBe(await access.realpath(join('d', 'f.txt')));
      expect((await access.realpath(join('d', 'f.txt'))).endsWith('f.txt')).toBe(true);
      expect(await codeOf(access.realpath(join('d', 'nope')))).toBe('ENOENT');
    } finally { await cleanup(); }
  });
}
