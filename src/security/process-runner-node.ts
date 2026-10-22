import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { killLeftovers, killProcessTree } from './kill-tree.js';
import type { ProcessResult, ProcessRunner, ProcessRunRequest } from './process-runner.js';

const IS_WINDOWS = process.platform === 'win32';
/** After the child exits, how long its output may stay open (held by grandchildren) before they are killed. */
const STDIO_CLOSE_GRACE_MS = 250;

/** One output stream, kept up to the byte cap. */
interface Captured {
  chunks: Buffer[];
  bytes: number;
  isTruncated: boolean;
}

function capture(params: { stream: Readable; maxBytes: number; onOverflow(): void }): Captured {
  const { stream, maxBytes, onOverflow } = params;
  const captured: Captured = { chunks: [], bytes: 0, isTruncated: false };
  stream.on('data', (chunk: Buffer) => {
    if (captured.isTruncated) return;
    const room = maxBytes - captured.bytes;
    captured.chunks.push(chunk.subarray(0, Math.max(0, room)));
    captured.bytes += Math.min(chunk.length, Math.max(0, room));
    if (chunk.length > room) { captured.isTruncated = true; onOverflow(); }
  });
  return captured;
}

function textOf(params: { captured: Captured; maxBytes: number }): string {
  const { captured: { chunks, isTruncated }, maxBytes } = params;
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  return isTruncated ? `${text}\n[output truncated at ${maxBytes} bytes; the process was stopped]` : text;
}

/**
 * The real `ProcessRunner`: `child_process.spawn` with `shell: false` (argv passed literally), the scrubbed env only,
 * hidden windows, and on POSIX a new process group so the whole tree can be signalled. The tree is killed on timeout,
 * abort or output overflow; after a normal exit, grandchildren still holding the output open are killed too, so no
 * process outlives the run.
 */
export function createNodeProcessRunner(): ProcessRunner {
  return {
    run: (request: ProcessRunRequest) => new Promise<ProcessResult>((resolve, reject) => {
      const { file, args, cwd, env, signal, timeoutMs, maxOutputBytes, stdin } = request;
      const startedAtMs = performance.now();
      // Wall-clock start, which Windows process creation times are compared with.
      const startedAt = Date.now();
      let sweeping: Promise<void> | undefined;
      let exitedAt: number | undefined;
      const child = spawn(file, [...args], { cwd, env, shell: false, windowsHide: true, detached: !IS_WINDOWS, stdio: ['pipe', 'pipe', 'pipe'] });
      let timedOut = false;
      let aborted = false;
      let killing: Promise<void> | undefined;
      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let isDone = false;
      const kill = (): void => { if (killing == null && child.pid != null) killing = killProcessTree({ pid: child.pid }); };
      const stdout = capture({ stream: child.stdout, maxBytes: maxOutputBytes, onOverflow: kill });
      const stderr = capture({ stream: child.stderr, maxBytes: maxOutputBytes, onOverflow: kill });
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const onAbort = (): void => { aborted = true; kill(); };
      if (signal?.aborted === true) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
      const finish = async (): Promise<void> => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        await killing;
        resolve({
          exitCode: exit?.code ?? null, ...(exit?.signal == null ? {} : { signal: exit.signal }),
          stdout: textOf({ captured: stdout, maxBytes: maxOutputBytes }), stderr: textOf({ captured: stderr, maxBytes: maxOutputBytes }),
          truncated: { stdout: stdout.isTruncated, stderr: stderr.isTruncated }, timedOut, aborted, durationMs: Math.round(performance.now() - startedAtMs),
        });
      };
      child.on('error', error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (child.pid == null) reject(error); else void finish();
      });
      // One sweep per run, whichever of the two paths below gets there first.
      const sweep = (): Promise<void> => {
        sweeping ??= child.pid == null ? Promise.resolve() : killLeftovers({ pid: child.pid, startedAt, exitedAt: exitedAt ?? Date.now() });
        return sweeping;
      };
      child.on('exit', (code, exitSignal) => {
        exit = { code, signal: exitSignal };
        exitedAt = Date.now();
        // Output still open after the exit is held by processes the child started: kill them, then stop waiting.
        setTimeout(() => {
          if (isDone || child.pid == null) return;
          void sweep().then(() => { child.stdout.destroy(); child.stderr.destroy(); void finish(); });
        }, STDIO_CLOSE_GRACE_MS).unref();
      });
      child.on('close', () => {
        // Even a clean close may leave a grandchild running (detached on Windows, in the group on POSIX): it goes with
        // the run. On Windows that takes a process-table query (about half a second), so the result does not wait.
        const swept = sweep();
        if (IS_WINDOWS) void finish(); else void swept.then(() => finish());
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin ?? '');
    }),
  };
}
