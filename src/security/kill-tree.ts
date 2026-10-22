import { execFile } from 'node:child_process';
import { join } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
/** POSIX: time between SIGTERM and SIGKILL for the process group. */
export const KILL_GRACE_MS = 2_000;
/** How often a POSIX group is polled while waiting for it to exit after SIGTERM. */
const GROUP_POLL_MS = 50;
/** Longest wait for the Windows helper programs (taskkill, PowerShell). */
const HELPER_TIMEOUT_MS = 15_000;
/** How far before the recorded start a descendant's creation time may read (the system tick is about 16 ms). */
const CREATION_CLOCK_SLACK_MS = 1_000;

/** Windows system programs by absolute path, so a planted `taskkill.exe` on PATH is never what runs. */
function systemProgram(relative: string): string {
  return join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', relative);
}

function runHelper(params: { file: string; args: string[] }): Promise<string> {
  const { file, args } = params;
  return new Promise(resolve => {
    // Failures (the process already gone, access denied) leave nothing more to do: the result is empty.
    execFile(file, args, { windowsHide: true, timeout: HELPER_TIMEOUT_MS }, (_error, stdout) => resolve(String(stdout ?? '')));
  });
}

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // ESRCH: the whole group is gone.
    return false;
  }
}

function signalGroup(params: { pid: number; signal: NodeJS.Signals }): void {
  try {
    process.kill(-params.pid, params.signal);
  } catch {
    // Already gone.
  }
}

/**
 * Kills a process and everything it started. Windows: `taskkill /T /F` (the tree by parent ids, forcibly). POSIX: the
 * child was started as a process-group leader, so the group gets SIGTERM, then SIGKILL after `graceMs` if any member
 * is still alive (a process that ignores SIGTERM is still killed).
 */
export async function killProcessTree(params: { pid: number; graceMs?: number }): Promise<void> {
  const { pid, graceMs = KILL_GRACE_MS } = params;
  if (IS_WINDOWS) {
    await runHelper({ file: systemProgram('taskkill.exe'), args: ['/PID', String(pid), '/T', '/F'] });
    return;
  }
  signalGroup({ pid, signal: 'SIGTERM' });
  for (let waited = 0; waited < graceMs && isGroupAlive(pid); waited += GROUP_POLL_MS) await new Promise(resolve => setTimeout(resolve, GROUP_POLL_MS));
  if (isGroupAlive(pid)) signalGroup({ pid, signal: 'SIGKILL' });
}

/** `killLeftovers` / `descendantsInTable`: the exited child and when it ran. */
export interface LeftoverQuery {
  pid: number;
  /** Epoch milliseconds, taken just before the child was spawned. */
  startedAt: number;
  /** Epoch milliseconds when the child exited: no later process can be its own child. */
  exitedAt?: number;
}

/**
 * The descendants of `pid` in a Windows process table (`ProcessId,ParentProcessId,CreationUnixMs` lines). Windows keeps
 * an orphan's parent id, even after that id is reused, so a parent id alone proves nothing: only processes created
 * after the child started count, and its direct children must also predate its exit (a later process naming that id
 * belongs to its next owner).
 */
export function descendantsInTable(params: LeftoverQuery & { table: string }): number[] {
  const { table, pid, startedAt, exitedAt } = params;
  // Process creation times come from the coarse system tick, so they may read slightly off the precise clock.
  const notBefore = startedAt - CREATION_CLOCK_SLACK_MS;
  const directNotAfter = exitedAt == null ? Number.POSITIVE_INFINITY : exitedAt + CREATION_CLOCK_SLACK_MS;
  const childrenOf = new Map<number, number[]>();
  for (const line of table.split(/\r?\n/)) {
    const [child, parent, created] = line.trim().split(',').map(Number);
    if (child == null || parent == null || created == null || ![child, parent, created].every(Number.isInteger) || child === parent || created < notBefore) continue;
    if (parent === pid && created > directNotAfter) continue;
    childrenOf.set(parent, [...childrenOf.get(parent) ?? [], child]);
  }
  const found: number[] = [];
  const pending = [...childrenOf.get(pid) ?? []];
  while (pending.length > 0) {
    const next = pending.pop() as number;
    if (found.includes(next)) continue;
    found.push(next);
    pending.push(...childrenOf.get(next) ?? []);
  }
  return found;
}

/** A Windows sweep waiting for the next process-table query. */
interface PendingSweep {
  query: LeftoverQuery;
  done(): void;
}

let pendingSweeps: PendingSweep[] = [];
let isSweeping = false;

/**
 * Runs the queued Windows sweeps, one process-table query (about half a second of PowerShell) per batch: every sweep
 * queued while a query runs waits for the next one, whose table is taken after its child exited.
 */
async function drainSweeps(): Promise<void> {
  isSweeping = true;
  while (pendingSweeps.length > 0) {
    const batch = pendingSweeps;
    pendingSweeps = [];
    const table = await runHelper({
      file: systemProgram(join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }'],
    });
    const descendants = [...new Set(batch.flatMap(({ query }) => descendantsInTable({ ...query, table })))];
    // No /T: every descendant is already listed, and taskkill's own tree walk trusts parent ids without creation times.
    if (descendants.length > 0) await runHelper({ file: systemProgram('taskkill.exe'), args: [...descendants.flatMap(child => ['/PID', String(child)]), '/F'] });
    for (const { done } of batch) done();
  }
  isSweeping = false;
}

/**
 * Kills whatever an already-exited child left running (grandchildren, detached or holding its output open). POSIX:
 * SIGKILL to its process group. Windows: its descendants from the process table (created while it ran, see
 * `descendantsInTable`), each forcibly; sweeps that overlap share one query. Best effort: a process that left the POSIX
 * group (`setsid`) is out of reach.
 */
export function killLeftovers(query: LeftoverQuery): Promise<void> {
  const { pid } = query;
  if (!IS_WINDOWS) { signalGroup({ pid, signal: 'SIGKILL' }); return Promise.resolve(); }
  return new Promise(resolve => {
    pendingSweeps.push({ query, done: resolve });
    if (!isSweeping) void drainSweeps();
  });
}
