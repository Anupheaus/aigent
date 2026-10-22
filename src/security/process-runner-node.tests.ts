import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeProcessRunner } from './process-runner-node.js';
import type { ProcessRunRequest } from './process-runner.js';
import { tempRoot } from './temp-dir.test-support.js';

const IS_WINDOWS = process.platform === 'win32';
let root = '';
let cleanup: () => Promise<void> = async () => undefined;
const scripts: Record<string, string> = {
  echo: 'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
  env: 'process.stdout.write(JSON.stringify(process.env))',
  flood: 'const line = "x".repeat(1000) + "\\n"; setInterval(() => { for (let n = 0; n < 100; n += 1) process.stdout.write(line); }, 0)',
  hang: 'setInterval(() => {}, 1000)',
  stubborn: 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  exit: 'process.stderr.write("bad"); process.exit(3)',
  stdin: 'let data = ""; process.stdin.on("data", chunk => { data += chunk; }); process.stdin.on("end", () => process.stdout.write(data.toUpperCase()))',
  // A grandchild that holds no output open (so the child's output closes at once) and, on Windows, is detached.
  detach: 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform === "win32" }); child.unref(); process.stdout.write(String(child.pid) + "\\n")',
  parent: 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); process.stdout.write(String(child.pid) + "\\n"); if (process.argv[2] === "exit") setTimeout(() => process.exit(0), 200); else setInterval(() => {}, 1000)',
};

beforeAll(async () => {
  ({ root, cleanup } = await tempRoot());
  for (const [name, source] of Object.entries(scripts)) await writeFile(join(root, `${name}.cjs`), source);
});
afterAll(() => cleanup());

const runner = createNodeProcessRunner();
const run = (script: string, extra: Partial<ProcessRunRequest> = {}) => runner.run({ file: process.execPath, args: [join(root, `${script}.cjs`)], cwd: root, env: {}, timeoutMs: 10_000, maxOutputBytes: 100_000, ...extra });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(params: { test(): boolean; ms: number }): Promise<boolean> {
  for (let waited = 0; waited < params.ms; waited += 100) {
    if (params.test()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return params.test();
}

describe('createNodeProcessRunner (real node subprocesses)', () => {
  it('passes every argument literally: shell syntax is never interpreted', async () => {
    const corpus = ['; echo pwned', '&& calc', '| more', '`id`', '$(id)', 'line1\nline2', '> out.txt', '*.ts', '?', '--', '-rf', '--output=/tmp/x', '"double"', "'single'", 'back\\slash\\', 'trail\\\\', '$HOME', '%PATH%', '^&', '', ' spaced  out ', 'é😀'];
    const result = await runner.run({ file: process.execPath, args: [join(root, 'echo.cjs'), ...corpus], cwd: root, env: {}, timeoutMs: 10_000, maxOutputBytes: 100_000 });
    expect(JSON.parse(result.stdout)).toEqual(corpus);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
  });

  it('property: the child receives byte-identical arguments', async () => {
    const arg = fc.string({ unit: 'grapheme', maxLength: 12 }).filter(value => !value.includes('\0'));
    await fc.assert(fc.asyncProperty(fc.array(arg, { maxLength: 6 }), async args => {
      const result = await runner.run({ file: process.execPath, args: [join(root, 'echo.cjs'), ...args], cwd: root, env: {}, timeoutMs: 10_000, maxOutputBytes: 100_000 });
      expect(JSON.parse(result.stdout)).toEqual(args);
    }), { numRuns: 25 });
  }, 120_000);

  it('gives the child only the environment it is handed', async () => {
    const secret = ['fake', 'aws', 'secret'].join('-');
    process.env.AWS_SECRET_ACCESS_KEY_AIGENT_TEST = secret;
    try {
      // PATH is always handed over (empty here): on Windows a missing PATH would be copied from the parent by libuv.
      const result = await run('env', { env: { ONLY: 'this', PATH: '' } });
      const seen = JSON.parse(result.stdout) as Record<string, string>;
      expect(seen.ONLY).toBe('this');
      expect(Object.values(seen)).not.toContain(secret);
      expect(Object.entries(seen).find(([name]) => name.toUpperCase() === 'PATH')?.[1]).toBe('');
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY_AIGENT_TEST;
    }
  });

  it('reports exit codes, stderr and stdin round trips', async () => {
    expect(await run('exit')).toMatchObject({ exitCode: 3, stderr: 'bad', timedOut: false });
    expect(await run('stdin', { stdin: 'hello' })).toMatchObject({ exitCode: 0, stdout: 'HELLO' });
  });

  it('cuts runaway output at the cap with a marker and kills the process', async () => {
    const started = performance.now();
    const result = await run('flood', { maxOutputBytes: 50_000 });
    expect(result.truncated.stdout).toBe(true);
    expect(result.stdout).toContain('[output truncated at 50000 bytes; the process was stopped]');
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(50_200);
    expect(performance.now() - started).toBeLessThan(8_000);
  });

  it('kills a process at its timeout, and one that ignores SIGTERM too', async () => {
    const hung = await run('hang', { timeoutMs: 300 });
    expect(hung).toMatchObject({ timedOut: true, aborted: false });
    expect(hung.durationMs).toBeLessThan(5_000);
    // On Windows taskkill /F is already forcible; on POSIX SIGTERM is ignored and SIGKILL follows after the grace.
    const stubborn = await run('stubborn', { timeoutMs: 300 });
    expect(stubborn.timedOut).toBe(true);
    expect(stubborn.durationMs).toBeLessThan(8_000);
    if (!IS_WINDOWS) expect(stubborn.signal).toBe('SIGKILL');
  });

  it('kills promptly on abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await run('hang', { signal: controller.signal });
    expect(result).toMatchObject({ aborted: true, timedOut: false });
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('leaves no grandchild behind when the tree is killed', async () => {
    const result = await run('parent', { timeoutMs: 1_500 });
    const grandchild = Number(result.stdout.trim().split('\n')[0]);
    expect(result.timedOut).toBe(true);
    expect(await waitUntil({ test: () => !isAlive(grandchild), ms: 5_000 })).toBe(true);
  });

  it('leaves no grandchild behind when the child exits on its own while it still runs', async () => {
    const result = await runner.run({ file: process.execPath, args: [join(root, 'parent.cjs'), 'exit'], cwd: root, env: IS_WINDOWS ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}, timeoutMs: 20_000, maxOutputBytes: 100_000 });
    const grandchild = Number(result.stdout.trim().split('\n')[0]);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await waitUntil({ test: () => !isAlive(grandchild), ms: 5_000 })).toBe(true);
  }, 30_000);

  it('leaves no grandchild behind when the child exits cleanly and its output closes at once', async () => {
    const result = await runner.run({ file: process.execPath, args: [join(root, 'detach.cjs')], cwd: root, env: IS_WINDOWS ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}, timeoutMs: 20_000, maxOutputBytes: 100_000 });
    const grandchild = Number(result.stdout.trim().split('\n')[0]);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    try {
      expect(await waitUntil({ test: () => !isAlive(grandchild), ms: 2_000 })).toBe(true);
    } finally {
      // Not left running if the assertion fails.
      if (isAlive(grandchild)) process.kill(grandchild);
    }
  }, 30_000);

  it('rejects when the program cannot be started', async () => {
    await expect(runner.run({ file: join(root, 'missing.exe'), args: [], cwd: root, env: {}, timeoutMs: 1_000, maxOutputBytes: 100 })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
