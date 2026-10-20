# Tool Cache, Shapers, Volatile Block, Plan and Todo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Cheaper, faster runs without losing fidelity: a deterministic-aware tool-result cache with per-entry statistics; a shaper pipeline that is verbatim-safe by construction; a trailing volatile block that keeps the prompt prefix byte-stable; and the consumer `plan` + agent `todo` machinery.

**Architecture:** The cache wraps tool execution (lookup before run, store after success) through the keyed write queue. Shapers are pure `(result, context) => shaped` functions registered with a declared `appliesTo` list and are only invoked when a tool declares `fidelity: 'lossy-ok'` for its `contentKind`; originals are kept behind handles. The volatile block is rebuilt per request and appended after the stable messages. Plan/todo state lives in run state, is mutated by tools and directives, and is rendered as a stable pinned definition block plus volatile status.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check. `node:crypto` for hashing. Nothing new to install.

**Spec:** master plan sections "Tool-result cache, flagged in the tool API", "Context economy / shaper pipeline and safety rule", "Prompt hygiene: volatile content goes last", "Consumer-supplied plan", "Agent-owned todo list", "Inline status updates" in `docs/design/master-plan.md`; earlier slice plans for conventions.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: no network; clocks/ids injected; **file content is verbatim by default** — nothing may alter a tool result unless the tool explicitly declares `fidelity: 'lossy-ok'` and the shaper's `appliesTo` includes the result's `contentKind`; cached results are returned as deep copies; failed results are never cached; side-effecting tools never cached.

## Review Focus

1. Verbatim guarantee: for every shaper and a corpus of tricky inputs (HTML file, SVG/XML, CSV, JSON/NDJSON, minified JS, Markdown, ANSI-containing file, repeated lines, base64, CRLF/BOM/trailing whitespace, tabs, empty, huge), a `file-content` / verbatim result is byte-identical after the full pipeline.
2. Cache correctness under concurrency: identical concurrent calls execute once (single-flight), hit counters exact under 50 parallel requesters, an invalidated entry (validity token changed) is never served, TTL expiry honoured with the injected clock, mutation of a returned result cannot affect later hits.
3. Cache keys: argument key order, `previous`/feedback fields and aliasing must not change a key; different tool versions (schema change) must not collide; global vs per-instance scope isolation (a non-deterministic cached result never visible to another instance).
4. Prefix stability: across turns, with only volatile content changing, the hash of everything before the volatile block is identical; a consumer-supplied block that churns is detected and warned in dev.
5. Plan/todo: statuses never regress silently (done → pending rejected without explicit reason), unknown ids and `done` without evidence rejected per item with precise errors, todo cap gives a clear error instead of dropping items, both survive being updated via tool and via directive in the same turn.

---

### Task 0: Tool-result cache

**Files:**
- Create: `src/cache/cache-key.ts`, `src/cache/tool-cache.ts`, `src/cache/cache-types.ts`, `src/cache/cache-stats.ts`, `src/cache/single-flight.ts`, `src/cache/cache-findings.ts`
- Modify: `src/tools/tool-types.ts` (`cacheKey?`, `validity?`, `version?`), `src/tools/define-tool.ts` (validate), `src/tools/execute-tool-call.ts` (lookup/store hooks via an injected `ToolCache`), `src/core/create-aigent.ts` (`cache?: CacheOptions | false`; default enabled with in-memory-store-backed entries using the runtime store, or a private in-memory store when none), `src/core/run-turn.ts`, `src/telemetry/*` (step `cacheHit`, `savedMs`), `src/scoring/report.ts` (fill `cache` findings), `src/core/agent-version.ts` (tool cache fields already included), `README.md`
- Test: beside each new file; integration in a new `src/core/create-aigent-cache.tests.ts`

**Interfaces (binding):**
- `Tool` gains: `cacheKey?: (args) => unknown` (normaliser; default identity), `validity?: (args, ctx: ToolContext) => Promise<string>` (a token that changes when the underlying data changes, e.g. mtime+size or content hash), `version?: string` (bump to invalidate; the schema hash is always part of the key).
- `computeCacheKey(params: { tool: Tool; args: unknown; isDefinitionScoped?: boolean }): string`: sha-256 hex of canonical JSON of `{ name, version, schemaHash, description, key: cacheKey(args), definition? }` (sorted keys; feedback fields are already stripped before this point). **Deviation (post-review):** the validity token is kept on the entry instead of in the key, so a changed token finds and replaces the stale entry (counted as an invalidation) rather than orphaning it; the `validity` parameter was removed (review M1). The description and, for instance-scoped entries, the tool's per-definition id joined the key, and deterministic entries default to the namespace `agent:<agentName>:<version>` (`cacheNamespace` / `sharedCache` opt into wider sharing) instead of `global` (review I1).
- `ToolCache = { lookup(request: CacheLookup): Promise<CacheHit | undefined>; store(request: CacheStore): Promise<void>; findings(): Promise<CacheFindings> }`; scope: `deterministic && cache` → namespace `global`; `!deterministic && cache` → namespace `instance:<instanceId>` and requires `cacheTtlMs` (already enforced). Entries live in the store collection `toolcache` (key = `${namespace}:${cacheKey}`) as `{ schemaVersion, namespace, tool, storedAt, expiresAt?, validity?, value, bytes, stats }` where `stats = { firstStoredBy: { agentName, runId }, totalHits, hitsByAgent: Record<string, number>, lastRequestedAt, missCount, invalidationCount, savedMs, savedTokens }`. All updates go through `updateRecord` inside the keyed write queue (queue key = cache key) so stats are exact under concurrency.
- Behaviour: `lookup` computes `validity` (if the tool defines it) → if entry exists and not expired and validity equal → hit (increments `totalHits`, `hitsByAgent[agent]`, `lastRequestedAt`, `savedMs += entry.originalDurationMs`, `savedTokens += entry.resultTokens`), else miss (`missCount++`; a validity mismatch also `invalidationCount++` and the stale entry is replaced on the next store). Results are deep-cloned (structuredClone) on store and on hit. Not cached: failures, results over `maxEntryBytes` (default 256 KiB), tools with `hasSideEffects`. Eviction: `maxEntries` (default 1000) and `maxBytes` (default 64 MiB) by least-recently-requested. **Single-flight**: concurrent identical lookups-in-progress for one key share one execution (second caller awaits the first and then records a hit).
- `CacheFindings = { hottest: { tool; key; hits; savedMs }[]; hitRateByTool: Record<string, number>; hitRateByAgent: Record<string, number>; worthMarkingDeterministic: { tool; repeatedIdenticalCalls: number }[] (derived from traces: non-deterministic, uncached tools called ≥3 times with identical normalised args in the same run across ≥2 runs); frequentlyInvalidated: { tool; invalidations: number; lookups: number }[] }` surfaced under `Report.cache`.
- Telemetry: the trace step gets `cacheHit: true` and the model still receives the normal envelope; activity views are still emitted for hits.

- [ ] **Step 1: Failing tests**: key stability (arg key order, `cacheKey` normaliser, different tool version/schema ⇒ different key); scope isolation (global shared by two agents/instances; per-instance not visible to another instance with the same name; requires TTL; TTL expiry with fake clock); validity change invalidates and counts; failures/oversize/side-effect never cached; copy semantics (mutate returned value, next hit unaffected); stats exactness with 50 parallel requesters from 5 agents (hits by agent sum to total; single-flight ⇒ tool executed once); eviction by entries and bytes keeps most recently requested; findings fixtures; integration: two agents, second agent's identical deterministic call is a hit, step `cacheHit`, `usage` unchanged except tool timing, activity view still emitted; cache disabled via `cache: false`.
- [ ] **Step 2: Run to verify failure.** [ ] **Step 3: Implement.** [ ] **Step 4: Suite + typecheck + build.**
- [ ] **Step 5: Commit** `feat: tool-result cache with scopes, validity, single-flight and statistics`.

---

### Task 1: Shaper pipeline (verbatim-safe) and original handles

**Files:**
- Create: `src/shapers/shaper-types.ts`, `src/shapers/run-shapers.ts`, `src/shapers/shaper-registry.ts`, `src/shapers/original-store.ts`, `src/shapers/result-original-tool.ts`, `src/shapers/builtin/tabular.ts`, `strip-noise.ts`, `fold-repeats.ts`, `html-boilerplate.ts`, `dedupe-reads.ts`, `src/shapers/alias-table.ts`, `src/shapers/verbatim-corpus.test-support.ts`
- Modify: `src/tools/tool-types.ts` (`contentKind?`, `fidelity?`, defaults `'file-content'`-safe: if omitted ⇒ `fidelity: 'verbatim'`), `src/tools/define-tool.ts`, `src/core/run-turn.ts` (apply shapers to the model-visible result AFTER cache store, so cache holds the original), `src/core/agent-types.ts` + `task-input.ts` (`shapers?: 'off' | { allow: string[] }`, per-call `verbatim` via tool arg is NOT added; per-tool `fidelity` and agent `shapers` are the controls), `src/telemetry/trace-recorder.ts` (`shaped: { shaper; tokensBefore; tokensAfter }[]`), `src/scoring/findings.ts` (net-negative shaper finding), `README.md`
- Test: beside each file + `src/shapers/verbatim-corpus.tests.ts`

**Interfaces (binding):**
- `ContentKind = 'file-content' | 'web-page' | 'command-output' | 'structured-data' | 'search-hits' | 'prose' | 'log' | 'binary-ref'`; `Fidelity = 'verbatim' | 'lossy-ok'`. A tool result carries the tool's declared kind/fidelity; undeclared ⇒ `fidelity: 'verbatim'`.
- `Shaper = { name: string; appliesTo: ContentKind[] (non-empty, required); shape(input: ShaperInput): ShaperOutput | undefined }`, `ShaperInput = { value: unknown; kind: ContentKind; text: string; context: ShaperContext }`; `ShaperOutput = { value: unknown; note: string }` (note is the visible marker, e.g. `"HTML boilerplate removed; full page: handle H7"`). `registerShaper` throws if `appliesTo` missing/empty (CI-gate equivalent).
- `runShapers(params): ShapedResult`: if fidelity is `verbatim` or shaping is off or the shaper's `appliesTo` excludes the kind ⇒ value returned identical (same reference not required but deep-equal and byte-identical when serialised). Each applied shaper stores the original under a handle (`H<n>` per run) in `OriginalStore` and appends its note to the result as `{ result: <shaped>, shaping: [{ shaper, note, handle }] }` — never altering the envelope for verbatim results.
- Built-in shapers (each with `appliesTo`): `tabular` (structured-data: arrays of ≥3 homogeneous flat objects ⇒ `{ columns: [...], rows: [[...]] }` dropping null/empty cells only when marked in a `omitted` note; lossless round trip function `decodeTabular` used by tests), `strip-noise` (command-output: ANSI escapes, `\r` progress overwrites, trailing whitespace, runs of >2 blank lines), `fold-repeats` (log, command-output: ≥3 identical consecutive lines ⇒ `line (x37)`), `html-boilerplate` (web-page ONLY: remove script/style/nav/footer/aside/comments, collapse whitespace; keeps main text), `dedupe-reads` (file-content results only when the tool declares `lossy-ok`… **no**: dedupe applies to `structured-data|search-hits|prose` repeats of an identical hash within a run ⇒ `"Same as call <id> (unchanged)"`; never touches `file-content`).
- Aliasing (`alias-table.ts`): `createAliasTable({ minLength: 24 })` gives short stable aliases `F1…` for long repeated strings **in tool results of lossy-ok kinds only**, adds the alias legend to the result, and `expandAliases(args, table)` expands aliases in tool **arguments** the model writes (deep, strings only, exact-match alias tokens) before validation/execution; never applied to file content. Table is run state (checkpointable: `toJSON`/`fromJSON`).
- `result_original` built-in tool (strict, `deterministic: false, cache: false`): `{ handles: string[] (1..10) }` ⇒ per-handle envelope with the verbatim original text (subject to `maxResultTokens`); registered only when at least one tool declares `lossy-ok`.
- Corpus (`verbatim-corpus.test-support.ts`): named fixtures `html-page`, `html-fragment`, `html-template`, `svg`, `xml`, `csv`, `tsv`, `json`, `ndjson`, `minified-js`, `markdown-decorated`, `ansi-file`, `repeated-lines`, `base64-blob`, `crlf-bom`, `trailing-whitespace`, `tabs`, `empty`, `huge-1mb`.

- [ ] **Step 1: Failing tests**: (a) corpus × every registered shaper × every `ContentKind` other than the shaper's `appliesTo` ⇒ no-op; corpus × full pipeline with `fidelity: 'verbatim'` (and with undeclared fidelity) ⇒ byte-identical serialised result; fast-check: any string/JSON value labelled verbatim comes out equal; (b) `file-content` kind with `lossy-ok` still untouched by every non-file shaper (guard: `file-content` is in no built-in `appliesTo`); (c) each shaper's positive cases (tabular round trip lossless; ANSI/progress stripped; repeats folded with exact count; HTML boilerplate removal keeps main text; dedupe stub references the right call id); (d) markers + handles: original retrievable via `result_original`; (e) alias expansion in args is exact and never touches results of file-content; collision/unknown alias tokens left alone; table JSON round trip; (f) registry rejects shaper without `appliesTo`; (g) agent `shapers: 'off'` and `{ allow }`; (h) trace step `shaped` records tokens before/after and a net-negative finding appears when `after >= before`; (i) read-edit-roundtrip test using a test fs-like tool pair declared verbatim: what the model sees equals the bytes on disk.
- [ ] **Step 2: Run to verify failure.** [ ] **Step 3: Implement.** [ ] **Step 4: Suite + typecheck + build.**
- [ ] **Step 5: Commit** `feat: verbatim-safe shaper pipeline, originals by handle and alias table`.

---

### Task 2: Volatile block and prefix stability

**Files:**
- Create: `src/context/volatile-block.ts`, `src/context/prefix-hash.ts`, `src/context/stability-monitor.ts`
- Modify: `src/core/run-turn.ts` (append volatile message to the request only), `src/core/create-aigent.ts` (`volatile?: { dateTime?: false | { granularity: 'minute' | 'hour' | 'day' }; timezone?: string; locale?: string }`), `src/core/aigent-events.ts` (no new event; reuse `warning`), `README.md`
- Test: beside files + integration

**Interfaces (binding):**
- `buildVolatileBlock(params: { clock: Clock; options: VolatileOptions; progress: { turn: number; maxTurns: number; toolCalls: number; maxToolCalls: number }; extras: VolatileSection[] }): string | undefined` → a single trailing `user`-role message text starting `# Current state` with deterministic ordering: date/time rounded to granularity (default minute; `false` disables), progress counters, then `extras` (`{ title; body }`, e.g. plan statuses from Task 3). Returns undefined when empty. The block is **added to the request only**, never appended to the stored `messages`, never compacted.
- `computePrefixHash(messages, tools): string`: sha-256 over canonical JSON of everything that precedes the volatile block (system, tool specs sorted, all stored messages).
- `createStabilityMonitor({ emit })`: `observe(turnIndex, prefixHash, previousMessagesCount)` — the prefix of turn N must equal the prefix of turn N−1 extended only at the tail: it keeps the hash of the first K messages (K = previous count) and warns once per run (`"Prompt prefix changed between turns without a compaction; a block is changing every turn and defeats provider prompt caching. Move changing content to the volatile block."`) when the leading K messages hash differently. Only active when `NODE_ENV !== 'production'` unless `volatile.warnOnPrefixChange` is set.
- Tests inject `clock`; changing time/progress/extras must NOT change the prefix hash.

- [ ] **Step 1: Failing tests**: block format and ordering; granularity rounding table; disable switch; undefined when empty; request has the volatile message last and stored history has none; prefix hash identical across 5 turns while the clock advances and progress counters change; monitor warns exactly once when a test consumer mutates an earlier message; no warning on normal growth; production env silences; deterministic with injected clock; FakeProvider-recorded requests assertion of identical prefixes turn to turn.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: volatile trailing block and prefix stability monitor`.

---

### Task 3: Plan and todo

**Files:**
- Create: `src/planning/plan-schema.ts`, `src/planning/plan-state.ts`, `src/planning/plan-complete-tool.ts`, `src/planning/todo-tool.ts`, `src/planning/render-pinned.ts`, `src/planning/apply-directives.ts`
- Modify: `src/core/task-input.ts` (`plan?`), `src/core/agent-types.ts` (`TaskResult.plan?`, `todo?`), `src/core/aigent-events.ts` (`plan-update`, `todo-update`), `src/core/system-prompt.ts`/`run-turn.ts` (pinned definition block in the stable messages; statuses via volatile extras), `src/core/run-task.ts` (incomplete items ⇒ status `incomplete`), telemetry (plan state in the run record), `README.md`
- Test: beside files + integration

**Interfaces (binding):**
- `PlanItem = { id (1..40, unique); label (1..80); description (1..1000); acceptanceCriteria: string[] (1..20, each 1..300) }`; `PlanStatus = 'pending' | 'in_progress' | 'done' | 'blocked'`; `PlanItemState = PlanItem & { status; evidence?: string }`. `TaskInput.plan?: PlanItem[]` (≤ 50 items) validated with precise errors (duplicate ids, empty criteria).
- `plan_complete` tool (strict, batch-style, `deterministic:false, cache:false`): `{ updates: [{ id, status, evidence? (≤500) }] }` min 1 max 50 ⇒ per-update envelope `{ index, ok, … }`; rules: unknown id ⇒ `unknown_plan_item` with the valid ids in `suggestion`; `done` without evidence ⇒ `evidence_required`; `done`/`blocked` → earlier status regression (`done` → `pending|in_progress`) ⇒ `status_regression` unless `evidence` present containing a reason (soft rule: allowed only with evidence, recorded); idempotent repeat of the same status ok. Emits `plan-update` events `{ type: 'plan-update'; items: PlanItemState[]; changed: string[] }` immediately.
- `todo` tool: `{ ops: [{ op: 'add'|'edit'|'delete'|'set_status', id?, label?, description?, status? }] }` (min 1, max 50); `add` generates ids `t1,t2…` unless `id` provided; per-op results; list capped at 100 items and total rendered pinned size capped (named constants) ⇒ `todo_full` error telling the agent to delete or merge items (never silently drops); emits `todo-update`.
- Pinned rendering: definitions (stable: plan ids/labels/criteria; todo ids/labels) go in ONE stable user-role message directly after the task brief and are rewritten only when items are added/edited/deleted (a plan change is a prefix change; acceptable and rare); **statuses** are rendered into the volatile block extras (`## Plan status`, `## Todo status`). Never compacted (the layout slice relies on a `pinned: true` flag on this message — add the flag to the internal message type now).
- Directives: `::aigent plan {"updates":[…]}` and `::aigent todo {"ops":[…]}` are applied through the SAME state functions as the tools (same validation; failures become `warning` events with the precise per-item reason and a one-line correction included in the next turn's volatile block). A directive and a tool call in the same turn both apply in arrival order.
- End of run: items not `done` ⇒ `TaskResult.status = 'incomplete'` (unless already failed/cancelled/stopped/limit_reached), `plan` and `todo` in the result and run record.

- [ ] **Step 1: Failing tests** for each rule above plus: pinned definition message present once and stable across turns (prefix hash), statuses only in volatile block; todo cap error; directive+tool same turn ordering; incomplete result status; plan validation errors; per-item envelope partial success; events emitted; run record contains plan/todo; unattended runs unaffected; plan/todo tools absent when no plan and agent didn't opt in (`planning: true` default false for todo? **ruling: the `todo` tool is registered by default for every agent unless `todo: false`; `plan_complete` only when a plan is supplied**).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: consumer plan, agent todo, pinned rendering and inline directives`.

---

## Self-review

Coverage: cache (T0), shapers + handles + aliasing + verbatim guard (T1), volatile + stability (T2), plan/todo (T3). Compaction, which consumes the `pinned` flag and volatile block, is the next slice. Names: `ToolCache`, `CacheFindings`, `Shaper`, `ContentKind`, `Fidelity`, `OriginalStore`, `AliasTable`, `PlanItem`, `PlanItemState`.
