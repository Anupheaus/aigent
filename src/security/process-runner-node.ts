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
      const startedAt = performance.now();
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
          truncated: { stdout: stdout.isTruncated, stderr: stderr.isTruncated }, timedOut, aborted, durationMs: Math.round(performance.now() - startedAt),
        });
      };
      child.on('error', error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (child.pid == null) reject(error); else void finish();
      });
      child.on('exit', (code, exitSignal) => {
        exit = { code, signal: exitSignal };
        // Output still open after the exit is held by processes the child started: kill them, then stop waiting.
        setTimeout(() => {
          if (isDone || child.pid == null) return;
          void killLeftovers(child.pid).then(() => { child.stdout.destroy(); child.stderr.destroy(); void finish(); });
        }, STDIO_CLOSE_GRACE_MS).unref();
      });
      child.on('close', () => {
        // Even a clean close may leave a detached grandchild in the group (POSIX): it goes with the run.
        if (!IS_WINDOWS && child.pid != null) void killLeftovers(child.pid);
        void finish();
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin ?? '');
    }),
  };
}
