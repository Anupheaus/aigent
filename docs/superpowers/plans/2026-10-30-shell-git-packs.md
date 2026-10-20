# Shell and Git Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `@anupheaus/aigent/tools/shell` (`shell_run`) and `@anupheaus/aigent/tools/git` (read-only `git_status`, `git_diff`, `git_log`, `git_blame`, plus separate gated opt-in `git_commit`/`git_push` tools), with the strongest permission model in the library: command allowlist, working-dir whitelist via `FsPolicy`, no shell expansion by default, timeouts, output caps, environment scrubbing, approvals, process-tree cleanup.

**Architecture:** A `ProcessRunner` interface (default `node:child_process.spawn` with `shell: false`) is the only way these packs execute anything, so tests use a fake runner for policy logic and real `node` subprocesses for runner behaviour (cross-platform: tests spawn `process.execPath` with `-e` scripts, never shell builtins). `ShellPolicy` decides allow/deny per `(command, args, cwd)`; git tools build argv themselves from validated fields and never accept raw argv.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check, `node:child_process`. No new dependencies. Git tests create temp repos by running the real `git` binary when present (skipped with a clear reason when git is not installed).

**Spec:** master plan sections "Built-in tool library" (Shell/process, Git), "Security (later packs): command injection, allowlist bypass, env leakage, runaway output; write-gating for git" in `docs/design/master-plan.md`; pack conventions in `docs/superpowers/plans/2026-10-28-fs-data-meta-packs.md`; approvals/dry-run/undo plan.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: **deny by default** (no allowed commands ⇒ `shell_run` refuses everything); never spawn through a shell unless `allowShell: true` is explicitly configured AND the call is approved; argv is an array, never a string to be parsed; child environment is a scrubbed allowlist (no inherited secrets); child processes are killed (whole tree) on timeout/abort/output-cap and never outlive the run; command output is untrusted data.

## Review Focus

1. Injection matrix: arguments containing `;`, `&&`, `|`, backticks, `$()`, newlines, `>` redirects, glob chars, leading `-` option injection, `--` handling, quotes, and env-var syntax are passed to the program literally (no shell) — assert with a real subprocess that echoes argv; allowlist bypass attempts (path variants `./git`, `GIT`, `git.exe`, symlinks named like an allowed command, `PATH` tricks, absolute path to a different binary with an allowed basename) are refused.
2. Runaway/hang: infinite output is cut at the cap with an explicit marker and the process tree is killed; a process ignoring SIGTERM is killed (escalation); a child that spawns grandchildren leaves none behind; abort kills promptly.
3. Environment leakage: parent secrets (`AWS_*`, `*_TOKEN`, `*_KEY`, `NPM_TOKEN`, `GITHUB_TOKEN`, anything not in the allowlist) are absent in the child; `PATH` is controlled.
4. Git read tools can never write: argv is fixed per tool, user-controlled fields (refs, paths) are validated (no leading `-`, no `--output`-style options, refs matching a conservative pattern), repository path must be inside the FsPolicy roots, hooks and external diff/pager/editor are disabled (`-c core.pager=cat -c core.hooksPath=<empty>` etc., `GIT_*` env scrubbed, `GIT_TERMINAL_PROMPT=0`).
5. Commit/push gates: `git_commit` and `git_push` are not registered unless explicitly enabled, always require approval, support dry-run, and `git_push` refuses force and non-allowlisted remotes/branches.

---

### Task 0: ProcessRunner and ShellPolicy

**Files:**
- Create: `src/security/process-runner.ts`, `src/security/process-runner-node.ts`, `src/security/shell-policy.ts`, `src/security/shell-policy-types.ts`, `src/security/scrub-env.ts`, `src/security/kill-tree.ts`
- Test: beside + `src/security/shell-policy.property.tests.ts` + real subprocess tests

**Interfaces (binding):** `ShellPolicyOptions = { commands: AllowedCommand[]; cwdPolicy: FsPolicy (cwd must pass `read` check); allowShell?: false; env?: { allow: string[]; set?: Record<string,string> }; maxOutputBytes (default 200_000); timeoutMs (default 30_000, max 600_000); maxConcurrent? }` with `AllowedCommand = { name: string (basename, e.g. 'git'); resolvedPath?: string; argRules?: { allowSubcommands?: string[]; denyArgs?: (string|RegExp)[]; maxArgs?: number }; requiresApproval?: boolean | ((argv) => boolean) }`. `checkCommand({ command, args, cwd }): Promise<CommandDecision>` resolves the executable via a trusted search (`resolvedPath` or PATH lookup restricted to configured `searchDirs`; the resolved real path's basename must equal the allowed name, not a symlink to something else when `strictResolve`), validates argv (array of strings, no NUL, length caps, subcommand allowlist, deny patterns), cwd via FsPolicy. `ProcessRunner.run({ file, args, cwd, env, signal, timeoutMs, maxOutputBytes }): Promise<{ exitCode: number | null; signal?: string; stdout; stderr; truncated: { stdout: boolean; stderr: boolean }; timedOut: boolean; aborted: boolean; durationMs }>` with kill-tree (Windows: `taskkill /T /F`; POSIX: process group kill with SIGTERM then SIGKILL after grace). `scrubEnv(parentEnv, spec)` returns only allowlisted names (case-insensitive on Windows) plus `set` values.

- [ ] **Step 1: Failing tests**: policy decision tables (Review Focus 1 & 3 with fake runner); real subprocess tests using `process.execPath`: argv literalness echo test over an injection corpus, output cap + kill, timeout + kill, SIGTERM-ignoring child escalation (skip on Windows where semantics differ, with equivalent taskkill test), grandchild cleanup, abort, env scrubbing (set a fake secret in the parent env during the test and assert absence), exit code/signal reporting; property test: for random argv strings the child receives byte-identical args.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: ShellPolicy, ProcessRunner with kill-tree and env scrubbing`.

---

### Task 1: shell_run tool

**Files:**
- Create: `src/tools/packs/shell/` (`shell-tools.ts`, `shell-run.ts`), barrel `index.ts`
- Modify: `package.json` exports `./tools/shell`, README
- Test: beside + integration through the agent loop

**Interfaces (binding):** `shellTools(options: { policy: ShellPolicy; runner?: ProcessRunner; approvals?: 'always' | 'by-policy' (default 'by-policy') })`. `shell_run` (batch, max 5 items, items run **sequentially in order** when `sequential: true` default else parallel up to `maxConcurrent`): item `{ command, args: string[] (≤64, each ≤4096), cwd?, timeoutMs?, stdin?: string (≤100_000) }` ⇒ `{ command, exitCode, stdout, stderr, truncated, timedOut, durationMs }` with `contentKind:'command-output'`, `fidelity:'lossy-ok'` (noise-strip/fold shapers may apply) but stdout is returned verbatim in `raw: true`; `hasSideEffects: true`, `deterministic:false, cache:false`, `requiresApproval` per policy (default: commands marked `requiresApproval`, plus any unlisted-subcommand ⇒ denied not asked), `resume: 'ask'`, `dryRun` returns the resolved command line + cwd + env names (no execution), no `undo`. Non-zero exit is a successful envelope with `exitCode` (the agent decides), policy/timeouts are failures; activity titles show `command + first args` truncated.

- [ ] **Step 1: Failing tests**: end-to-end with real `node` as an allowed command: stdout/stderr/exit codes, cwd policy, timeout/cap markers, approval flow (`approval-request` emitted, decision resumes), unattended ⇒ denied unless pre-granted, dry-run executes nothing (assert a side-effect file is not created), stdin, batch sequencing, shaper interplay (command-output shapers apply only when lossy-ok and handle returned), resume policy `ask` on restore, activity view.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: shell tool pack`.

---

### Task 2: Git pack

**Files:**
- Create: `src/tools/packs/git/` (`git-tools.ts`, `git-run.ts` (argv builder + hardened env), `git-validate.ts` (ref/path validation), `git-status.ts`, `git-diff.ts`, `git-log.ts`, `git-blame.ts`, `git-commit.ts`, `git-push.ts`), barrel `index.ts`
- Modify: `package.json` exports `./tools/git`, README
- Test: beside + `git-tools.integration.tests.ts` (real temp repos; skipped with reason if `git` is unavailable)

**Interfaces (binding):** `gitTools(options: { policy: ShellPolicy-like (reuses ProcessRunner + FsPolicy for repo path); enableWrites?: { commit?: boolean; push?: { remotes: string[]; branches: string[] } }; runner? })`. Read tools are batch (max 10) with `repo` path per item (default first root), `contentKind:'command-output'`/`search-hits`, `fidelity:'verbatim'` for diff/blame/log text, `deterministic` keyed on commit hash where the request pins a commit (`git_log`/`git_diff` between two full hashes ⇒ `deterministic:true, cache:true`; otherwise `false, cache:false`; status never cached). `git_status` ⇒ branch, ahead/behind, entries `{ path, index, worktree }` parsed from `--porcelain=v2 -z`. `git_diff` items `{ repo, from?: ref, to?: ref, paths?: string[], staged?: boolean, contextLines? (≤20), maxBytes? }` ⇒ unified diff text truncated at cap with marker plus stat summary. `git_log` items `{ repo, ref?, paths?, limit (≤200), since?, author?, grep? }` ⇒ commits `{ hash, author, date, subject }` via a fixed `--format` with NUL separators. `git_blame` items `{ repo, path, startLine?, endLine?, ref? }` ⇒ per-line `{ line, hash, author, date, text }` from `--porcelain`. Validation: refs match `^[A-Za-z0-9][A-Za-z0-9._/@^~{}-]{0,199}$` and must not contain `..` ranges unless the field is a range, never start with `-`; paths are checked against FsPolicy relative to the repo and passed after `--`. Hardened invocation: `git -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=<empty temp> -c protocol.ext.allow=never --no-optional-locks`, env `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`, no `GIT_*` inherited. `git_commit` (only if `enableWrites.commit`): `{ repo, message (1..2000), paths: string[] (explicit, no `-a`), allowEmpty?: false }`, `hasSideEffects`, `requiresApproval: true`, `risk: 'medium'`, `dryRun` (status of what would be committed), `undo` (soft reset to the previous HEAD if HEAD unchanged since), `resume: 'verify'` (HEAD message/tree check). `git_push` (only if configured): `{ repo, remote, branch }` with remote/branch allowlists, **never force**, requires approval, `risk: 'high'`, no undo, `dryRun` via `git push --dry-run`.

- [ ] **Step 1: Failing tests** (real temp repos built in `beforeAll` with fixed author/date env for determinism): status/diff/log/blame vs `git` plumbing ground truth on a scripted history; refs/paths injection corpus (`--output=/tmp/x`, `-p`, `;rm`, `HEAD..--upload-pack=…`, `$(…)`, newline) rejected before spawning; repo outside roots denied; hooks disabled (a repo with a malicious `pre-commit`/`post-checkout` hook and `core.fsmonitor` in local config does not run it during status/diff/log/blame: assert a marker file is never created); pager/editor env ignored; truncation markers; determinism flags and cache hits for pinned-hash calls; commit gated (unregistered by default; approval required; dry-run leaves HEAD unchanged; undo soft-resets; commit with explicit paths only; hooks disabled on commit unless `runHooks:true`); push refuses force/unlisted remote/branch (use a local bare repo remote), dry-run, approval.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: git tool pack with hardened read tools and gated writes`.

---

## Self-review

Coverage: process/policy (T0), shell_run (T1), git (T2). Names: `ShellPolicy`, `ProcessRunner`, `AllowedCommand`, `CommandDecision`, `shellTools`, `gitTools`.
