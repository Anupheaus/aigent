import { execFile } from 'node:child_process';
import { join } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
/** POSIX: time between SIGTERM and SIGKILL for the process group. */
export const KILL_GRACE_MS = 2_000;
/** How often a POSIX group is polled while waiting for it to exit after SIGTERM. */
const GROUP_POLL_MS = 50;
/** Longest wait for the Windows helper programs (taskkill, PowerShell). */
const HELPER_TIMEOUT_MS = 15_000;

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

/** Windows keeps an orphan's parent id, so the process table still says which processes a finished child started. */
async function windowsDescendants(pid: number): Promise<number[]> {
  const table = await runHelper({
    file: systemProgram(join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
    args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }'],
  });
  const childrenOf = new Map<number, number[]>();
  for (const line of table.split(/\r?\n/)) {
    const [child, parent] = line.trim().split(',').map(Number);
    if (child == null || parent == null || !Number.isInteger(child) || !Number.isInteger(parent) || child === parent) continue;
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

/**
 * Kills whatever an already-exited child left running (grandchildren holding its output open). POSIX: SIGKILL to its
 * process group. Windows: its descendants from the process table, forcibly. Best effort: a process id reused in the
 * meantime is the documented residual risk.
 */
export async function killLeftovers(pid: number): Promise<void> {
  if (!IS_WINDOWS) { signalGroup({ pid, signal: 'SIGKILL' }); return; }
  const descendants = await windowsDescendants(pid);
  if (descendants.length > 0) await runHelper({ file: systemProgram('taskkill.exe'), args: [...descendants.flatMap(child => ['/PID', String(child)]), '/T', '/F'] });
}
