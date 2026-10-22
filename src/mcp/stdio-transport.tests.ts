import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpClient } from './mcp-client.js';
import { createStdioTransport } from './stdio-transport.js';

/** A tiny MCP server over stdio: echo, pid (its own process id), exit (crashes), plus a malformed line at start. */
const SERVER_SOURCE = `
const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdout.write('this is not json\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tiny', version: '1' } } });
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
  const { name, arguments: args } = message.params;
  if (name === 'exit') { process.stderr.write('bye'); process.exit(3); }
  const text = name === 'pid' ? String(process.pid) : name === 'env' ? String(process.env[args.key]) : JSON.stringify(args);
  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
});
`;

/** Writes its pid to the file named by its first argument, then waits on stdin forever. */
const PID_SERVER_SOURCE = `
require('node:fs').writeFileSync(process.argv[2], String(process.pid));
process.stdin.resume();
`;
/**
 * Starts a lingering grandchild that writes its pid to the file named by the first argument, then crashes (exit code 3)
 * once that file exists, leaving the grandchild behind.
 */
const ORPHANING_SERVER_SOURCE = `
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const file = process.argv[2];
const linger = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000);";
// On Windows a child leaves the server's job object only when detached; elsewhere it stays in the server's process group.
spawn(process.execPath, ['-e', linger, file], { stdio: 'ignore', detached: process.platform === 'win32' });
const poll = setInterval(() => { if (existsSync(file)) { clearInterval(poll); process.exit(3); } }, 20);
`;
/** How long the pid-writing server may take to start before the test treats it as never started. */
const PID_FILE_WAIT_MS = 5_000;
const POLL_MS = 25;

let directory: string;
let script: string;
let pidScript: string;
let orphaningScript: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aigent-mcp-'));
  script = join(directory, 'server.cjs');
  await writeFile(script, SERVER_SOURCE);
  pidScript = join(directory, 'pid-server.cjs');
  await writeFile(pidScript, PID_SERVER_SOURCE);
  orphaningScript = join(directory, 'orphaning-server.cjs');
  await writeFile(orphaningScript, ORPHANING_SERVER_SOURCE);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone.
    return false;
  }
}

async function waitForPid(file: string): Promise<number | undefined> {
  const deadline = Date.now() + PID_FILE_WAIT_MS;
  while (Date.now() < deadline) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text !== '') return Number(text);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  return undefined;
}

async function waitUntilGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + PID_FILE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  return false;
}

function connect(env?: Record<string, string>) {
  const warnings: string[] = [];
  const client = createMcpClient({ transport: createStdioTransport({ type: 'stdio', command: process.execPath, args: [script], ...(env == null ? {} : { env }) }), serverName: 'tiny', warn: message => warnings.push(message) });
  return { client, warnings };
}

const signal = new AbortController().signal;

describe('stdio transport with a real node subprocess', () => {
  it('talks newline-delimited JSON-RPC, ignores a malformed line and kills the process on close', async () => {
    const { client, warnings } = connect();
    await client.connect();
    expect((await client.listTools()).map(({ name }) => name)).toEqual(['echo']);
    expect((await client.callTool({ name: 'echo', args: { text: 'hi' }, signal })).content).toEqual([{ type: 'text', text: '{"text":"hi"}' }]);
    const pid = Number((await client.callTool({ name: 'pid', args: {}, signal })).content.map(part => (part as { text: string }).text).join(''));
    expect(isAlive(pid)).toBe(true);
    expect(warnings).toEqual(["MCP server 'tiny': ignored a frame that is not valid JSON (16 characters)"]);
    await client.close();
    expect(isAlive(pid)).toBe(false);
  });

  it('reports a crash mid-call with the exit code and stderr', async () => {
    const { client } = connect();
    await client.connect();
    await expect(client.callTool({ name: 'exit', args: {}, signal })).rejects.toMatchObject({ init: { code: 'mcp_server_exited', message: "MCP server 'tiny' exited while tools/call was pending: exit code 3; stderr: bye" } });
    await client.close();
  });

  it('starts the server with a scrubbed environment plus the configured variables', async () => {
    const secretName = 'AIGENT_TEST_' + 'SECRET_TOKEN';
    process.env[secretName] = 'should-not-leak';
    try {
      const { client } = connect({ GIVEN: 'yes' });
      await client.connect();
      const read = async (key: string): Promise<unknown> => (await client.callTool({ name: 'env', args: { key }, signal })).content[0];
      expect(await read('GIVEN')).toEqual({ type: 'text', text: 'yes' });
      expect(await read(secretName)).toEqual({ type: 'text', text: 'undefined' });
      await client.close();
    } finally {
      delete process.env[secretName];
    }
  });

  it('fails to start a command that does not exist', async () => {
    const client = createMcpClient({ transport: createStdioTransport({ type: 'stdio', command: join(directory, 'missing-program') }), serverName: 'missing', warn: () => undefined });
    await expect(client.connect()).rejects.toThrow("could not start '");
  });

  it('kills a crashed server\'s leftover descendants on close', async () => {
    const pidFile = join(directory, 'grandchild.pid');
    const transport = createStdioTransport({ type: 'stdio', command: process.execPath, args: [orphaningScript, pidFile] });
    let onExit: (reason: string) => void = () => undefined;
    const exited = new Promise<string>(resolve => { onExit = resolve; });
    await transport.start({ onMessage: () => undefined, onWarning: () => undefined, onClose: reason => onExit(reason) });
    const grandchild = await waitForPid(pidFile);
    try {
      expect(grandchild).toBeDefined();
      expect(await exited).toContain('exit code 3');
      expect(isAlive(grandchild ?? 0)).toBe(true);
      await transport.close();
      expect(await waitUntilGone(grandchild ?? 0)).toBe(true);
    } finally {
      // Never leave the lingering process behind, whatever the assertions found.
      if (grandchild != null && isAlive(grandchild)) process.kill(grandchild);
    }
  }, 30_000);

  it('kills a server whose spawn finishes after close() was called, and rejects the start', async () => {
    const pidFile = join(directory, 'late.pid');
    const transport = createStdioTransport({ type: 'stdio', command: process.execPath, args: [pidScript, pidFile] });
    const started = transport.start({ onMessage: () => undefined, onWarning: () => undefined, onClose: () => undefined });
    const closed = transport.close();
    await expect(started).rejects.toThrow('the transport was closed while the server was starting');
    await closed;
    const pid = await waitForPid(pidFile);
    // A server killed before it wrote its pid never ran long enough to matter; one that did must be gone.
    if (pid != null) expect(await waitUntilGone(pid)).toBe(true);
  });
});
