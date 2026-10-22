import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { killProcessTree } from '../security/kill-tree.js';
import { DEFAULT_ENV_ALLOW, scrubEnv } from '../security/scrub-env.js';
import { createLineDecoder, encodeFrame } from './json-rpc.js';
import type { McpTransport, McpTransportHandlers } from './mcp-transport.js';
import type { McpStdioTransportConfig } from './mcp-types.js';

const IS_WINDOWS = process.platform === 'win32';
/** How much of the server's stderr is kept to explain an unexpected exit. */
const STDERR_TAIL_CHARS = 2_000;
/** How long `close()` waits for the killed process to report its exit. */
const EXIT_WAIT_MS = 5_000;

function exitReason(params: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): string {
  const { code, signal, stderr } = params;
  const how = signal != null ? `killed by ${signal}` : `exit code ${String(code)}`;
  const tail = stderr.trim();
  return tail === '' ? how : `${how}; stderr: ${tail}`;
}

/**
 * An MCP server started as a child process (no shell, scrubbed environment), speaking newline-delimited JSON-RPC on
 * stdin/stdout. `close()` kills its whole process tree.
 */
export function createStdioTransport(config: McpStdioTransportConfig): McpTransport {
  const { command, args = [], env = {}, cwd } = config;
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<void> | undefined;
  let isClosing = false;
  /** The spawn in flight, so `close()` called meanwhile resolves only once that process is gone too. */
  let starting: Promise<void> | undefined;

  function attach(params: { process: ChildProcessWithoutNullStreams; handlers: McpTransportHandlers }): void {
    const { process: running, handlers } = params;
    let stderr = '';
    const decoder = createLineDecoder({ onOversized: chars => handlers.onWarning(`dropped an oversized frame (${chars} characters)`) });
    const deliver = (lines: string[]): void => {
      for (const line of lines) {
        try {
          handlers.onMessage(JSON.parse(line));
        } catch {
          // A server may print logs on stdout by mistake; one bad line must not end the connection.
          handlers.onWarning(`ignored a frame that is not valid JSON (${line.length} characters)`);
        }
      }
    };
    running.stdout.setEncoding('utf8');
    running.stdout.on('data', (chunk: string) => deliver(decoder.push(chunk)));
    running.stderr.setEncoding('utf8');
    running.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS); });
    // Writes to a server that already exited fail through `send`; the stream error itself needs no handling.
    running.stdin.on('error', () => undefined);
    exited = new Promise(resolve => {
      running.on('exit', (code, signal) => {
        deliver(decoder.end());
        if (!isClosing) handlers.onClose(exitReason({ code, signal, stderr }));
        resolve();
      });
    });
  }

  async function stop(running: ChildProcessWithoutNullStreams): Promise<void> {
    if (running.pid == null) return;
    running.stdin.end();
    await killProcessTree({ pid: running.pid });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, EXIT_WAIT_MS); })]);
    clearTimeout(timer);
  }

  async function spawnServer(handlers: McpTransportHandlers): Promise<void> {
    const childEnv = scrubEnv({ parent: process.env, spec: { allow: DEFAULT_ENV_ALLOW, set: env }, platform: IS_WINDOWS ? 'win32' : 'posix' });
    const running = spawn(command, args, { cwd, env: childEnv, shell: false, windowsHide: true, detached: !IS_WINDOWS, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      running.once('spawn', () => resolve());
      running.once('error', error => reject(new Error(`could not start '${command}': ${error.message}`)));
    });
    child = running;
    attach({ process: running, handlers });
    if (!isClosing) return;
    // close() ran while the process was starting and found nothing to kill: this process must not outlive it.
    await stop(running);
    throw new Error(`the transport was closed while the server was starting ('${command}')`);
  }

  function start(handlers: McpTransportHandlers): Promise<void> {
    starting = spawnServer(handlers);
    return starting;
  }

  function send(message: Parameters<McpTransport['send']>[0]): Promise<void> {
    const running = child;
    if (running == null || isClosing || running.exitCode != null || running.stdin.destroyed) return Promise.reject(new Error('the server process is not running'));
    return new Promise((resolve, reject) => {
      running.stdin.write(encodeFrame(message), error => (error == null ? resolve() : reject(error)));
    });
  }

  async function close(): Promise<void> {
    if (isClosing) { await exited; return; }
    isClosing = true;
    const running = child;
    if (running == null) {
      // A start in flight kills its own process once it sees the close; its rejection belongs to start's caller.
      await starting?.catch(() => undefined);
      return;
    }
    if (running.pid == null || running.exitCode != null || running.signalCode != null) return;
    await stop(running);
  }

  return { start, send, close };
}
