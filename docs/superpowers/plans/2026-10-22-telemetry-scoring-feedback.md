# Telemetry, Scoring, Feedback and Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Every run leaves a complete, versioned, privacy-hookable record (run + step trace + tool telemetry); agents can report outcomes and feedback cheaply; users can rate responses; `ai.report()` turns the data into scores and findings; request analysis finds cheaper paths and suggests new tools.

**Architecture:** A `recorder` collects trace steps while the loop runs (pure data, no I/O) and the run finalizer writes `runs`, `traces`, `feedback` through the keyed write queue after the `redact` hook. Scoring and analysis are pure functions over stored records so they are trivially testable with fixtures; `ai.report()` reads the store and calls them.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check. Nothing new to install.

**Spec:** master plan sections "Efficiency and speed scoring", "Agent feedback / enableFeedback", "Tool telemetry", "Outcome feedback on the previous tool use", "Request-level analysis", "User feedback on responses", "Agent versioning", "Privacy defaults" in `C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`; slices 1-3 plans/reports under `docs/superpowers/plans/` and `.superpowers/sdd/`.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: no network; clocks/ids injected; stored records carry `schemaVersion`, `agentName`, `instanceId`, `mode`, `agentVersion`, `scope` (opaque, passed through untouched); the `redact` hook runs before every store write and cannot be bypassed; `disableTelemetry` runs write nothing (activity events still stream) and are excluded from scores; feedback/outcome fields add zero tokens when `enableFeedback` is false.

## Review Focus

1. `enableFeedback` default (true unless `NODE_ENV === 'production'`, explicit value wins) controls the tool, prompt addendum, `previous` field and directive instructions together; when off, request bodies contain none of them.
2. The `previous` field and `::aigent outcome` directive for the same step must produce exactly one stored outcome (directive wins); `previous` must be stripped before the tool runs and before the args are cached/recorded as tool args.
3. Concurrent runs of one agent must not lose or interleave writes (record counts exact under 30 parallel runs) and a failing store write must not fail the run or poison later writes (warning event instead).
4. Scores must be deterministic and robust: zero/one run, missing pricing, zero tokens, divide-by-zero, baselines shifting, ties.
5. Privacy: with a `redact` hook, no un-redacted prompt/answer/args/result text reaches any store write (assert via a recording store across every collection).

---

### Task 0: Run records, trace and tool telemetry

**Files:**
- Create: `src/telemetry/run-record.ts` (types + zod schema, `RUN_RECORD_SCHEMA_VERSION = 1`), `src/telemetry/trace-recorder.ts`, `src/telemetry/estimate-tokens.ts`, `src/telemetry/redact.ts`, `src/telemetry/persist-run.ts`, `src/tools/truncate-result.ts`
- Modify: `src/core/run-turn.ts`, `run-task.ts`, `start-task-run.ts`, `create-aigent.ts` (options `redact?`, `captureContent?: boolean` default true, `retention?: { expiresInMs?: number }`), `src/store/store-types.ts` (optional `purge?(filter): Promise<number>`), `src/store/in-memory-store.ts` (implements `purge`), `src/tools/execute-tool-call.ts` (result sizing/truncation), `src/tools/tool-types.ts`, `README.md`
- Test: beside each new file; integration in `create-aigent.tests.ts`

**Interfaces (binding):**
- `TraceStep = { index: number; turn: number; callId: string; parentCallId?: string; tool: string; argsSummary: string; args?: unknown (only when captureContent); ok: boolean; errorCategory?: ToolErrorCategory; errorCode?: string; itemFailures?: number; itemTotal?: number; cacheHit?: boolean; resultBytes: number; resultTokens: number; truncated: boolean; durationMs: number; startedAtMs: number; outcome?: { success: boolean; answer: string; source: 'directive' | 'previous' } }`.
- `RunRecord = { schemaVersion: 1; runId; responseId; agentName; instanceId; mode: 'task'; agentVersion; version?: string; label?; scope?; model; settings; unattended: boolean; status; usage (TaskUsage + retries/fallbacks); timings: { startedAt; firstTokenMs?; durationMs; modelMs; toolMs; queuedMs }; stepCount; failureCount; task?: string; answer?: string (content only when captureContent); expiresAt?: number }` stored in `runs` (key `runId`), with its steps in `traces` (key `runId`, `{ schemaVersion, runId, agentName, steps: TraceStep[] }`).
- `estimateTokens(text: string): number` = `Math.ceil(length / 4)`; `argsSummary` = first 120 chars of canonical JSON.
- Truncation: a tool's `maxResultTokens` (default none) truncates the **model-visible** result: if serialized result exceeds the budget it is replaced by `{ truncated: true, note: 'Result truncated to ~N tokens (was ~M); narrow the request or page through it.', preview: <first N tokens of the JSON text> }` inside the envelope result; the step records `truncated: true`, original `resultBytes/resultTokens`. Failed envelopes are never truncated.
- `persistRun` writes through the keyed write queue (key = agent name) after applying `redact(record)`; `redact?: (record: StoredRecord) => StoredRecord` is applied to **every** record of every collection (`{ collection, key, value }` in, same shape out) before `Store.compareAndSet`, including the `runs` record's `settings.providerOptions` and `fallbacks[].settings.providerOptions` (stored as configured since slice 3; a test must cover them); store failures are caught, reported as one `warning` event (`"Could not save run record: …"`), and never fail the run. `disableTelemetry` skips persistence entirely. Records get `expiresAt = now + retention.expiresInMs` when configured.
- `responseId` (`ids.next('resp')`) is added to `TaskResult` and the final `done` event payload (`{type:'done', status, responseId}` — update tests/types).
- `ai.purge(filter)` → calls `store.purge` if present else rejects with a clear error; filter `{ agentName?: string; runId?: string; before?: number }`.
- `ai.trace(runId)` returns `{ run: RunRecord; steps: TraceStep[] } | undefined`.

- [ ] **Step 1: Write failing tests**: recorder builds ordered steps with turn numbers and timings from a scripted run (fake clock); nested `aigent_multi` inner calls get `parentCallId`; batch partial failures record `itemFailures/itemTotal`; truncation (exact marker text, flags, sizes, failure not truncated); estimateTokens; schema validation round trip of stored records; run record fields incl. `agentVersion`, `scope` passthrough, `schemaVersion`; `captureContent: false` stores no prompt/answer/args; `redact` applied to every collection (recording store) and cannot be bypassed by omitting it from a code path (assert collection set); store failure → warning, run still completes, later writes still succeed; 30 parallel runs of one agent → exactly 30 runs + 30 traces, no loss; `disableTelemetry` writes nothing and emits activity; `expiresAt`; `ai.purge`; `ai.trace`.
- [ ] **Step 2: Run to verify failure.** [ ] **Step 3: Implement.** [ ] **Step 4: Suite + typecheck + build.**
- [ ] **Step 5: Commit** `feat: versioned run records, step traces, tool telemetry, redact and purge`.

---

### Task 1: Agent feedback — enableFeedback, aigent_feedback, previous outcome

**Files:**
- Create: `src/feedback/resolve-enable-feedback.ts`, `src/feedback/feedback-prompt.ts`, `src/feedback/feedback-tool.ts`, `src/feedback/previous-outcome.ts`, `src/feedback/with-feedback-fields.ts`
- Modify: `src/core/system-prompt.ts` (feedback addendum), `src/core/run-turn.ts` (strip `previous`, link outcomes, dedupe), `src/core/create-aigent.ts` (`enableFeedback` runtime/agent option), `src/core/agent-version.ts` (include resolved `enableFeedback`), `README.md`
- Test: beside each file; integration in `create-aigent.tests.ts`

**Interfaces (binding):**
- `resolveEnableFeedback(params: { explicit?: boolean; env: Record<string, string | undefined> }): boolean`: explicit wins; else `env.NODE_ENV !== 'production'`.
- `aigent_feedback` tool (strict, batch-style, `deterministic: false, cache: false`, side-effect free to the world): `{ entries: [{ kind: 'easy'|'hard'|'suggestion'|'missing'|'simplify', text (1..500), relatedTool? (≤64) }] }` min 1, max 10; stores to the `feedback` collection (`kind: 'agent'`, keyed `${runId}:${callId}:${index}`) via the write queue; `describeActivity` required. Only registered when feedback enabled.
- `withFeedbackFields(tool): Tool` adds a REQUIRED `previous: { success: boolean; answer: string (≤300) }` property to a tool's args schema and JSON schema **only when enabled and only for calls after the first of a run** — implement as: schema always lists `previous` as optional-nullable in the strict subset (so the model may send null on the first call), and the loop strips `previous` from args before validation/execution/caching and records it. Calls missing a non-null `previous` after the first step are NOT rejected (soft requirement) but a `warning` event is emitted once per run. `aigent_multi` carries one `previous` at its top level only (inner calls do not); a `previous` the model puts inside inner calls is stripped, ignored and reported with one `warning` per `aigent_multi` call (slice 4 review, I-2). A tool that declares its own `previous` argument is rejected at `ai.agent()` with `invalid_definition` while feedback is on (I-3).
- Prompt addendum (only when enabled): a tiny block describing `previous`, `aigent_feedback` and `::aigent outcome/status` directives; absent when disabled; deterministic text; part of the stable system prompt; version hash includes the resolved flag.
- Outcome linking: an `outcome` directive (from `::aigent outcome`) or a `previous` field is attached to the **previous tool step**: the last top-level work step (start order, `aigent_multi` inner calls and `aigent_feedback` excluded) of an **earlier turn** than the report. A call's `previous` and a directive can only describe results the model has seen, which are the results of earlier model requests; parallel siblings in the report's own turn (even ones that have already finished) are never targets. The first `previous` report on a step wins and later ones (e.g. from parallel siblings) are ignored; a directive replaces a `previous` report, never the other way round (corrected after the slice 4 review, I-1); if both exist for the same step the directive wins and one record results (`source`); outcomes stored on the step and aggregated into `RunRecord`-level `outcomeSummary: { claimedSuccess: number; claimedFailure: number }`.

- [ ] **Step 1: Write failing tests**: env/explicit table for the flag; when disabled, provider request bodies contain no `previous`, no `aigent_feedback`, no directive text (assert on FakeProvider recorded requests) and system prompt is identical to the no-feedback prompt; when enabled all present and tool list sorted; `previous` stripped before the tool's `run` (assert tool receives args without it) and not part of recorded args or cache keys; first call with `previous: null` ok; later call missing `previous` yields exactly one warning; directive+previous dedupe (directive wins); outcome attaches to the right step in parallel-call turns (rule: the last top-level work step of an earlier turn; first `previous` wins; a directive after the turn's tool calls still targets the earlier turn); `aigent_feedback` batch validation errors precise, stores entries (30 concurrent runs no loss); schema snapshot of a wrapped tool; version hash changes with the flag.
- [ ] **Step 2: Run to verify failure.** [ ] **Step 3: Implement.** [ ] **Step 4: Suite + typecheck + build.**
- [ ] **Step 5: Commit** `feat: enableFeedback, aigent_feedback tool and previous-outcome linking`.

---

### Task 2: User feedback on responses

**Files:**
- Create: `src/feedback/user-feedback.ts`, `src/feedback/user-feedback-schema.ts`
- Modify: `src/core/create-aigent.ts` (`ai.feedback`), `src/core/agent-types.ts` (`TaskResult.feedback(f)`), `README.md`
- Test: beside files

**Interfaces:** `UserFeedback = { responseId: string; rating: 'correct' | 'incorrect' | 'partial'; comment?: string (≤2000); expectedAnswer?: string (≤10_000) }`. `ai.feedback(feedback): Promise<void>`: validates (zod, precise errors; unknown `responseId` → `invalid_input` error naming the id, determined by looking up the run by `responseId` through an index record in collection `responses` keyed by responseId → `{ runId, agentName, instanceId, agentVersion }` written by `persistRun`), stores in `feedback` (`kind: 'user'`, key `responseId`, amendable: later calls replace via `updateRecord`, keeping `history: [{at, rating, comment}]`), passes through `redact` and the write queue, and marks the run record `userVerdict` (rating) so scoring can read it without a join. `result.feedback(f)` is sugar. Works after the run finished and after `ai.close()`/new `createAigent` on the same store.

- [ ] **Step 1: Failing tests**: valid/invalid payload table; unknown id; amend keeps history; works from a second `createAigent` on the same store; sets `userVerdict`; concurrent feedback for the same response no lost history; `disableTelemetry` runs have no responseId index → clear error; redact applied.
- [ ] **Step 2–4:** run-fail, implement, suite. [ ] **Step 5: Commit** `feat: user feedback on responses`.

---

### Task 3: Scoring and report

**Files:**
- Create: `src/scoring/score.ts`, `src/scoring/baseline.ts`, `src/scoring/findings.ts`, `src/scoring/report.ts`, `src/scoring/report-types.ts`, `src/scoring/pricing.ts`
- Modify: `src/core/create-aigent.ts` (`ai.report`, `pricing?` option `Record<string, { inputPerMTokUsd; outputPerMTokUsd; cachedInputPerMTokUsd? }>` keyed `provider:model`), `README.md`
- Test: fixtures-based tests beside files (`fixtures.test-support.ts` builds run records/traces)

**Interfaces (binding):**
- `ai.report(filter?: ReportFilter): Promise<Report>`; `ReportFilter = { agentName?; instanceId?; agentVersion?; since?: number; label?; unattended?: boolean; includeDisabled?: false; compareVersions?: [string, string]; minRuns?: number (default 5) }`.
- `Report = { generatedAt; filter; runCount; agents: AgentReport[]; findings: Finding[]; requests: RequestAnalysis[]; toolSuggestions: ToolSuggestion[]; cache: CacheFindings (empty arrays until the cache slice) ; comparison?: VersionComparison }` where `AgentReport = { agentName; agentVersion; runs; scores: { speed; tokenEfficiency; turnEfficiency; toolEfficiency; cost; reliability } (each `{ value: number | null; label: 'fast'|'slow'|'efficient'|'inefficient'|'average'|'insufficient-data'; evidence: string }`), totals: { tokens; costUsd | null; durationMs; turns; toolCalls }, medians, p90s }`. Scores are 0..100, **relative to the agent's own rolling baseline** (median of the previous N=50 runs of the same agent+version; runs < `minRuns` ⇒ `insufficient-data`); definitions: speed = baselineMedianDuration / duration capped, tokenEfficiency analogous on total tokens (cached tokens weighted 0.1), turnEfficiency from `toolCallsPerTurn` and turns vs baseline, toolEfficiency = batch ratio (items per call) and low repeat rate, cost from `pricing` (null when no pricing), reliability = share of runs with status completed, no failed-tool retries beyond baseline and no `userVerdict: incorrect` (user verdict overrides agent-claimed success). Pure functions: `scoreRuns(params: { runs: RunRecord[]; baseline: RunRecord[] }): AgentScores`.
- `Finding = { id; kind; severity: 'info'|'warn'|'bad'; label: 'fast'|'slow'|'efficient'|'inefficient'; agentName; subject (tool/run/stage); message; evidence: Record<string, unknown> }` kinds: `slow-tool`, `failing-tool`, `verbose-tool` (high result tokens / context share), `unbatched-repeats` (same tool ≥3 times with similar args in a run), `too-many-turns` (turns high vs tool calls per turn low), `high-retry-rate`, `claimed-success-user-incorrect`, `expensive-run`, `slow-run`, `truncation-frequent`, `guardrail`-ready extension point. Deterministic ordering (severity desc, then id).
- `compareVersions`: before/after medians and deltas for duration, tokens, turns, toolCallsPerTurn, cost, reliability.

- [ ] **Step 1: Failing tests** with fixture records of known timings/tokens: exact scores/labels; insufficient-data under minRuns; baseline shift; ties/zero tokens/zero runs/no pricing safe (no NaN/Infinity anywhere — property test over random records asserts every number is finite); user verdict overrides claimed success; each finding kind from a crafted fixture and absent from a clean one; deterministic ordering; filters (agent, version, since, label, unattended, disabled excluded); compareVersions; `ai.report()` integration reading a store populated by real runs of the FakeProvider; efficiency story test: 50 tool calls in 3 turns scores higher turnEfficiency than 50 in 45.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: scoring, baselines, findings and ai.report`.

---

### Task 4: Request analysis and tool suggestions

**Files:**
- Create: `src/analysis/trace-group.ts`, `src/analysis/request-efficiency.ts`, `src/analysis/sequence-mining.ts`, `src/analysis/tool-suggestions.ts`
- Modify: `src/scoring/report.ts` (fill `requests`, `toolSuggestions`), `README.md`
- Test: beside files, fixture traces

**Interfaces (binding):** pure functions over `{ run: RunRecord; steps: TraceStep[] }`:
- `groupSimilarTasks(runs, options?: { threshold: number }): TaskGroup[]` — normalise task text (lowercase, strip punctuation/stopwords, digits→`#`), token-set Jaccard ≥ 0.6 (default) clusters, deterministic order; runs without stored task content group by `label` else single-run groups.
- `analyseRequest(group): RequestAnalysis = { groupId; sampleTask; runs; successfulRuns (agent claimed success on last outcome AND no user `incorrect`); cheapestSuccessful?: { runId; tokens; turns; toolCalls; durationMs; path: string[] }; typical: { medianTokens; medianTurns; medianToolCalls }; wastedSteps: { runId; stepIndex; reason: 'failed-before-success'|'repeat-call'|'unbatched'|'superseded-search' }[]; potentialSaving: { tokens; turns } }`; incorrect-by-user traces excluded from "cheapest successful".
- `mineSequences(traces, options?: { minLength: 2; maxLength: 5; minSupport: 3 })`: frequent contiguous tool-name sequences ending in a step with a successful outcome; supports counts distinct runs, ignores sequences wholly inside a single batch.
- `suggestTools(sequences, traces): ToolSuggestion[] = { name (snake_case derived from tool names, e.g. search_then_read), description, replaces: string[] (the sequences), supportingRunIds, proposedArgs: { name; type }[] (union of arg keys seen at the first step), estimatedSaving: { tokensPerUse; turnsPerUse; timePerUseMs } }`; none when no sequence reaches support.

- [ ] **Step 1: Failing tests**: grouping table (same task different wording/numbers group; unrelated don't); fixture "search → read → search → read to find a file" ×4 runs yields a suggestion with expected saving, "easier way" analysis picks the cheapest successful run and flags wasted steps; user-incorrect run excluded; no suggestion below support; determinism (shuffle input order ⇒ same output, property test); `ai.report()` includes `requests`/`toolSuggestions` from real FakeProvider runs.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: request analysis, sequence mining and tool suggestions`.

---

## Self-review

Coverage: records/privacy/telemetry (T0), agent feedback and outcomes (T1), user feedback (T2), scoring/report/versions/cache-ready findings (T3), analysis and suggestions (T4). Cache findings are a placeholder shape filled by the cache slice. Type names used consistently: `RunRecord`, `TraceStep`, `Finding`, `Report`, `ReportFilter`, `ToolSuggestion`, `UserFeedback`.
