# Filesystem, Data/Format and Agent/Meta Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The first built-in tool packs, each opt-in via a sub-path entry: `@anupheaus/aigent/tools/fs` (policy-guarded filesystem tools), `.../tools/data` (json/csv/diff/regex/calc), `.../tools/meta` (`delegate` and wiring for built-ins already in core), all following the shared rules (strict zod, batch-first, per-item envelopes, `deterministic`/`cache`, `contentKind`/`fidelity`, `maxResultTokens`, `describeActivity`, approvals, dry-run, undo).

**Architecture:** `FsPolicy` is a pure, heavily property-tested path authority that every fs tool must go through; tools take an injected `FsAccess` (default `node:fs/promises`) so tests run against a real temp directory and a fake. Each tool is a small file built with `defineBatchTool`. Reads declare `fidelity: 'verbatim'`, `contentKind: 'file-content'` and cache on `path + mtime + size`.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check, `node:fs/promises`, `node:path`. No new dependencies (CSV parsing and diffing are implemented in-house, small and tested).

**Spec:** master plan sections "Built-in tool library", "Filesystem", "Security (1b)", approvals/dry-run/undo sections in `C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: **deny by default** (no root configured ⇒ every fs tool fails with a precise `denied` error); every path is canonicalised (resolve, realpath for existing prefixes) BEFORE the policy check and the checked canonical path is the one used for the operation (no TOCTOU re-resolution through a different string); tools never read/write outside whitelisted roots even through symlinks, `..`, drive letters, UNC paths, 8.3 short names, case tricks on case-insensitive roots or alternate data streams; file contents are untrusted data; tests use temp directories only and clean up.

## Review Focus

1. Path escape: property test over generated paths (`..`, absolute, UNC `\\server\share`, `C:` drive-relative `C:foo`, mixed separators, trailing dots/spaces on Windows, `%2e%2e`-like literal names, NUL bytes, very long paths, symlink/junction into and out of a root, case variants) — a path outside every whitelisted root is NEVER accessible; a path inside a root is accessible per its permissions.
2. Write safety: a write through a symlink that points outside is denied; `fs_write` to an existing file with `overwrite:false` refuses; `fs_edit` fails closed when `oldText` is ambiguous or absent (never partially applies); batch edits to one file apply atomically (all or none).
3. Output safety: huge files, binary files, and files with unusual encodings/BOM/CRLF are handled (size caps with explicit truncation markers, binary detection ⇒ `binary-ref`), and reads are byte-faithful for text (CRLF/BOM preserved in `raw` mode).
4. Search honesty: `fs_search` never reports a match that is not in the file and never silently skips readable in-scope files (skips are counted and listed by reason: ignored, binary, too large, denied).
5. Prompt injection in file content cannot change the policy, approvals, or trigger directives (relies on the guardrail slice; test with injected text in a file read through the agent loop).

---

### Task 0: FsPolicy and FsAccess

**Files:**
- Create: `src/security/fs-policy.ts`, `src/security/fs-policy-types.ts`, `src/security/canonical-path.ts`, `src/security/fs-access.ts`, `src/security/fs-access-node.ts`, `src/security/ignore-rules.ts`
- Test: beside + `src/security/fs-policy.property.tests.ts`, `src/security/fs-access-node.tests.ts` (real temp dirs)

**Interfaces (binding):**
- `FsPolicyOptions = { roots: { path: string; permissions: ('read'|'write'|'delete')[]; label?: string }[]; denyGlobs?: string[] (default `['**/.git/**','**/.env','**/.env.*','**/*.pem','**/*.key','**/node_modules/**' only for write/delete, not read]`); maxReadBytes?: number (default 1 MiB); maxWriteBytes?: number (default 1 MiB); maxFiles?: number; caseSensitive?: boolean (default: platform) ; approval?: (op) => boolean }`.
- `createFsPolicy(options): FsPolicy` with `check(request: { path: string; permission: 'read'|'write'|'delete'; access: FsAccess }): Promise<PolicyDecision>` where `PolicyDecision = { allowed: true; canonicalPath: string; root: string } | { allowed: false; code: 'no_roots' | 'outside_roots' | 'permission_denied' | 'denied_glob' | 'invalid_path' | 'too_large'; message: string; suggestion?: string }`; `canonicalise(path)` resolves relative paths against the first root (or a configured `cwd`), rejects NUL/control characters, normalises separators, resolves symlinks via `access.realpath` for the longest existing prefix, and for non-existing targets re-attaches the remaining segments after verifying none is `..`. Windows: reject alternate data streams (`:` after the drive), device names (CON, NUL, COM1…), UNC unless a root is UNC, trailing dot/space segments. Case-insensitive compare on Windows/macOS defaults.
- `FsAccess` interface (`stat`, `lstat`, `realpath`, `readFile`, `writeFile`, `mkdir`, `readdir`, `rename`, `rm`, `copyFile`, `open` for ranged reads) — `createNodeFsAccess()` and `createMemoryFsAccess(files)` for tests.
- `matchGlob(pattern, path)` small in-house glob (`**`, `*`, `?`, `[abc]`, `{a,b}`) tested; `ignore-rules.ts` parses `.gitignore`-style files for search defaults.

- [ ] **Step 1: Failing tests**: decision table (no roots; inside/outside; read-only root write attempt; deny glob; invalid path chars); **property tests** per Review Focus 1 on Linux-style and Windows-style path generators (inject platform behaviour through options so both run on any OS); real symlink tests on temp dirs (skip with clear reason if symlink creation is not permitted on the platform); canonical path is used for the operation; memory access fake parity with node access on a shared contract test.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: FsPolicy, canonical paths and filesystem access layer`.

---

### Task 1: Filesystem tools

**Files:**
- Create: `src/tools/packs/fs/index.ts` is a barrel only; `fs-tools.ts` (`fsTools(options: FsToolsOptions): Tool[]`), `fs-read.ts`, `fs-list.ts`, `fs-search.ts`, `fs-stat.ts`, `fs-write.ts`, `fs-edit.ts`, `fs-move.ts`, `fs-delete.ts`, `fs-shared.ts` (item envelope helpers, policy gate)
- Modify: `package.json` (`exports` `./tools/fs`, `./tools/data`, `./tools/meta`; build includes them), `tsconfig` unaffected, README
- Test: beside each + `fs-tools.integration.tests.ts` (agent loop + FakeProvider over a real temp dir)

**Interfaces (binding):** `FsToolsOptions = { policy: FsPolicy; access?: FsAccess; approvals?: 'writes' | 'deletes' | 'none' (default 'deletes'); backupDir?: string; clock }`. All tools are batch tools (`items` array, max 50, per-item envelope):
- `fs_read` items `{ path, offset? (line, 1-based), limit? (lines, default 2000), raw?: boolean }` ⇒ `{ path, text, startLine, endLine, totalLines, truncated, encoding, bytes }`; **verbatim** (`contentKind:'file-content'`, `fidelity:'verbatim'`), `deterministic:false, cache:true`, `cacheKey` normaliser by canonical path, `validity` = `mtimeMs:size` (so edits invalidate), `maxResultTokens` 8000; binary files ⇒ `{ binary:true, bytes, mimeGuess }` not content; very long lines cut with explicit marker only beyond 20_000 chars/line.
- `fs_list` items `{ path, recursive?, depth? (≤8), glob?, includeHidden?, limit? (≤2000) }` ⇒ entries `{ path, type, size, mtimeMs }`, sorted, `truncated` + counts; honours deny globs and ignore rules (reported as `skipped`).
- `fs_search` items `{ path, pattern, kind: 'name'|'content', regex?: boolean, caseSensitive?, wholeWord?, glob?, contextLines? (≤5), maxMatches? (≤500) }` ⇒ grouped by file with line numbers, match counts first (`totalMatches`, `files`), `skipped: { ignored, binary, tooLarge, denied }` counts + sample paths, `truncated` with follow-up hint; ignores `node_modules`, `.git`, build output, lockfiles and minified files by default (`includeIgnored: true` to override) — the skip list is part of the result, never silent; `contentKind:'search-hits'`, `fidelity:'verbatim'`; deterministic ordering.
- `fs_stat`, `fs_write` (`{ path, content, overwrite?: boolean (default false), createDirs? }`; `hasSideEffects`; backup of prior content to `backupDir` for undo; `dryRun` returns planned effect with diff summary; `undo`/`applyUndo` restore or delete), `fs_edit` (`{ path, edits: [{ oldText, newText, replaceAll? }] }` per item; exact-match semantics; ambiguous (multiple matches without `replaceAll`) or absent ⇒ failure, **all edits for a path apply atomically**: compute on the in-memory text, write via temp file + rename; reports `replacements`; `dryRun` diff; `undo`), `fs_move`, `fs_delete` (moves to managed trash under `backupDir` when configured so undo works; else deletes, `undo` unavailable; requires approval by default). Write/delete/move declare `requiresApproval` per `approvals` option, `risk`, `resume: 'verify'` with `verify()` comparing content hashes, and `hasSideEffects: true`.
- Activity renderers for all (titles like "Reading 3 files", failure reasons from structured errors).

- [ ] **Step 1: Failing tests** (real temp dir): every tool happy path + per-item partial failures; policy denials surface as `denied` envelopes with suggestions; Review Focus 2–4 as tests (atomic multi-edit, ambiguity, symlink write denied, CRLF/BOM raw faithful read, binary detection, huge file truncation markers, search never reports phantom matches vs an exhaustive reference scan on a generated tree of 500 files incl. skip accounting); cache invalidation on mtime change through the agent loop; dryRun leaves the tree byte-identical (snapshot hash of the directory); undo restores (write/edit/move/delete) and reports partial; approvals required for deletes; read→edit round trip (what the model saw equals disk).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: filesystem tool pack`.

---

### Task 2: Data/format pack and agent/meta pack

**Files:**
- Create: `src/tools/packs/data/` (`json-query.ts`, `csv-query.ts`, `text-diff.ts`, `regex-extract.ts`, `calc.ts`, `data-tools.ts`), `src/tools/packs/meta/` (`delegate-tool.ts`, `meta-tools.ts`), `src/tools/packs/csv.ts` (RFC 4180 parser), `src/tools/packs/diff.ts` (Myers diff), `src/tools/packs/expression.ts` (safe arithmetic parser — no `eval`)
- Test: beside each

**Interfaces (binding):** all batch, deterministic and globally cacheable (`deterministic:true, cache:true`), `contentKind:'structured-data'` except `text_diff` (`prose`), `fidelity:'verbatim'` unless noted.
- `json_query` items `{ json: string | path-less inline text, query: string }` where query is a small JSONPath subset (`$`, `.key`, `[n]`, `[*]`, `..key`, filters `[?(@.a == 1)]` limited ops) implemented in-house; errors precise.
- `csv_query` items `{ csv: string, select?: string[], where?: [{ column, op: 'eq'|'ne'|'gt'|'lt'|'contains'|'startsWith', value }], orderBy?, limit? (≤1000), header?: boolean }` ⇒ rows; results declared `structured-data` `lossy-ok` (tabular shaper may apply).
- `text_diff` items `{ a: string, b: string, context? }` ⇒ unified diff + stats. `regex_extract` items `{ text, pattern, flags?: 'gimsu' subset, maxMatches? }` with a **ReDoS guard** (pattern length cap, run in bounded steps via `vm`-free approach: reject nested quantifier patterns heuristically and enforce a match-time budget by chunking input ≤ 200_000 chars; document limits). `calc` items `{ expression }` safe arithmetic (`+ - * / % ^`, parentheses, functions `min max abs round floor ceil sqrt pow log`), exact error on division by zero/NaN, no identifiers beyond constants `pi e`.
- `delegate` tool (agent/meta): `{ agent: string, task: string, returnBudgetTokens?: number }` — calls another named agent registered in the same runtime (`ai.agent` registry by name; `delegateTargets` option lists allowed agent names, default none ⇒ tool not registered) as a sub-agent: sets `parent: { agentName, instanceId, runId }` on its run, rolls its activity into the parent's `current` list, rolls usage/cost into the parent's totals (`usage.delegated`), enforces depth ≤ 3 and a `returnBudget` (answer truncated with marker + handle), propagates stop/cancel, returns an envelope with the sub-run's status, answer, usage and errors. `metaTools(options)` returns `[delegate]`; `aigent_multi`, `aigent_feedback`, `plan_complete`, `todo`, `ask_user`, `result_original` remain core-registered.

- [ ] **Step 1: Failing tests**: each tool table tests incl. error cases; csv RFC edge cases (quotes, embedded newlines, BOM, CRLF); diff correctness property test (applying the diff to `a` yields `b`); calc precedence/associativity/err cases + fuzz (never throws non-AigentError, never evaluates code); regex guard rejects pathological patterns quickly and handles large input within budget; json query subset table; delegate: parent/child linkage in records, usage rollup, depth limit, stop propagation, return budget truncation, disallowed agent name error, activity rollup in `current`.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: data/format and agent/meta tool packs`.

---

## Self-review

Coverage: policy (T0), fs tools (T1), data + meta (T2). Search tuning/index work belongs to the benchmark slice. Names: `FsPolicy`, `FsAccess`, `PolicyDecision`, `FsToolsOptions`, `fsTools`, `dataTools`, `metaTools`.
