/** `ProcessRunner.run`: one program with its argv array (never a command line), no shell. */
export interface ProcessRunRequest {
  /** Absolute path of the executable (resolved and checked by the `ShellPolicy`). */
  file: string;
  /** Passed to the program literally: no shell, no expansion, no splitting. */
  args: readonly string[];
  cwd: string;
  /** The child's whole environment (already scrubbed): nothing is inherited beyond it. */
  env: Record<string, string>;
  /** Aborting kills the process tree. */
  signal?: AbortSignal;
  /** The process tree is killed after this long. */
  timeoutMs: number;
  /** Per stream: past it the output is cut (with a marker) and the process tree is killed. */
  maxOutputBytes: number;
  /** Written to the child's stdin, which is then closed (closed at once without it). */
  stdin?: string;
}

/** What a run did. Output is untrusted data. */
export interface ProcessResult {
  /** Null when the process was killed by a signal (or its code is unknown). */
  exitCode: number | null;
  /** The signal that ended it (POSIX), when one did. */
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/** The only way the shell and git packs execute anything; tests inject fakes, the default spawns without a shell. */
export interface ProcessRunner {
  /** Resolves when the process and its output are done; rejects only when the program could not be started. */
  run(request: ProcessRunRequest): Promise<ProcessResult>;
}
