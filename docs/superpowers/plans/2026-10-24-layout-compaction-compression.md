# Context Layout, Compaction and Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Long runs stay inside the context window without losing what matters and without breaking provider prompt caching: flagged messages, a cache-friendly layout `[system][non-compactable][summary][recent+new][volatile]`, token-pressure compaction with hysteresis, and an optional `Compressor` interface (no heavy model shipped).

**Architecture:** Run state holds `ContextMessage`s (flags + metadata) instead of bare provider messages. A pure `assembleRequest` turns state into a `ProviderRequest` (stable prefix, cache breakpoints, trailing volatile block). A pure compaction planner decides what to stub/drop/summarise; an effectful compactor performs the summary call through the normal provider path. Compression is a pluggable async function cached by content hash in the store.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check. No new dependencies; LLMLingua is NOT implemented (it needs a model download) — only the interface, a deterministic fake, and docs.

**Spec:** master plan sections "Model settings, context size and compaction (cache-friendly)", "Prompt compression (LLMLingua) as an optional plugin", "Context economy" in `C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`; previous slice plans (esp. `2026-10-23-cache-shapers-volatile-plan.md` for the volatile block, `pinned` flag, original handles, prefix hash).

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: no network; clocks/ids injected; questions, answers, pinned messages, system/persona/skillset, plan/todo definitions, directive records and the compaction summary are **never compacted or altered**; between compactions the request prefix is append-only (byte-identical to the previous turn's prefix plus new tail); compaction never starts while a tool round is half done; a compaction that cannot make room fails with a clear `context_overflow` error rather than sending an oversized request or silently dropping anything.

## Review Focus

1. Property: over random histories and any number of compactions, every non-compactable message survives byte-identical and in chronological order, and exactly one summary message exists.
2. Hysteresis: compaction fires at `compactAt` and stops at `compactTo`; it does not thrash (no compaction on consecutive turns for a steady stream of small messages).
3. A tool call and its tool result are never separated (compacting a result away must leave a paired stub; an assistant message with tool calls is never summarised without its results, and vice versa) — otherwise providers reject the request.
4. Cache stability: prefix hash across turns is unchanged except at compaction events; after a compaction the next turns are append-only again; breakpoints land at the four boundaries.
5. Compression is deterministic and cache-safe: same input+compressor+params ⇒ byte-identical output from the store cache; protected tokens (negations, numbers, paths, identifiers, code spans, quoted strings, URLs) survive in the output; originals retrievable.

---

### Task 0: Context messages, flags and request assembly

**Files:**
- Create: `src/context/context-message.ts`, `src/context/message-flags.ts`, `src/context/assemble-request.ts`, `src/context/estimate-prompt-tokens.ts`, `src/context/cache-breakpoints.ts`
- Modify: `src/providers/provider-types.ts` (`ProviderRequest.cacheBreakpoints?: number[]` — indices into `messages` after which a cache breakpoint should be set; `ProviderMessage` unchanged), `src/providers/anthropic-messages.ts` (map breakpoints to `cache_control` on the last content block of the indicated messages, at most 3 + the system block's), `src/core/run-turn.ts`/`run-task.ts` (state uses `ContextMessage`; conversion at the provider boundary), `src/core/agent-types.ts` (`TaskResult.usage.contextTokensPeak?`), `README.md`
- Test: beside files + integration

**Interfaces (binding):**
- `ContextMessage = { id: string; seq: number; message: ProviderMessage; kind: 'system'|'brief'|'user'|'assistant'|'tool'|'question'|'answer'|'summary'|'pinned'|'directive'|'stub'; compactable: boolean; pinned: boolean; tokens: number; createdAt: number; originalHandle?: string; pairId?: string }` (`pairId` = the call id linking an assistant tool-call message to its tool result messages).
- Defaults (`defaultFlags(kind)`): `system`, `brief`, `question`, `answer`, `summary`, `pinned`, `directive` ⇒ `compactable: false`; `user`, `assistant`, `tool`, `stub` ⇒ `compactable: true`; `pinned` flag settable per message (user pin ⇒ `compactable: false`). Tools may mark a result non-compactable (`Tool.compactable?: boolean` default true).
- `assembleRequest(params: { state: ContextMessage[]; tools: ProviderToolSpec[]; settings; volatile?: string; model: string }): { request: ProviderRequest; prefixLength: number }` produces the layout: system first; then non-compactable messages in stable chronological order; then the (single) summary if present; then compactable messages in order; then the volatile block as the last `user` message (request only). Between compactions the order is simply stored order (append-only): the hoisting happens only inside `applyCompaction` (Task 1), so `assembleRequest` does NOT reorder (it asserts the invariant in dev mode: non-compactable messages precede the summary which precedes compactable ones **only after a compaction has run**; before the first compaction stored order is used). `cacheBreakpoints` = indices of: last system message, last non-compactable message before the summary/compactables, the summary (if any), and the last stable message before the volatile block.
- `estimatePromptTokens(request): number` = sum over messages of `ceil(chars/4)` + per-message overhead 4 + tool specs; after each response the provider-reported `inputTokens` calibrates a correction ratio kept in run state (`calibrate(estimated, reported)`, clamped 0.5..2.0).
- `contextSize` = resolved `modelSettings.contextSize ?? provider.capabilities.maxContextTokens`; usable budget = `contextSize - reservedOutput(maxOutputTokens ?? 4096)`.

- [ ] **Step 1: Failing tests**: default flags table; layout order before/after a (hand-built) compaction; breakpoints positions; Anthropic `cache_control` placement incl. cap of 4 total; OpenAI ignores breakpoints; estimate monotonic + calibration clamps; token budget math; prefix identical across turns with only appended messages (using `computePrefixHash`); pairing metadata preserved through conversion; existing suites unchanged.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: context messages with flags and cache-friendly request assembly`.

---

### Task 1: Compaction

**Files:**
- Create: `src/context/compaction-policy.ts`, `src/context/plan-compaction.ts`, `src/context/apply-compaction.ts`, `src/context/tool-result-stub.ts`, `src/context/summarise.ts`, `src/context/compactor.ts`
- Modify: `src/core/run-turn.ts` (check pressure before each request; run compaction at a safe boundary: between turns, never mid tool-round), `src/core/agent-types.ts` (`compaction?: Partial<CompactionPolicy>`; `compactionModel?: string`), `src/core/aigent-events.ts` (`compaction` event `{ type: 'compaction'; stage: 'stubbed'|'deduped'|'summarised'; tokensBefore; tokensAfter; messagesAffected; summaryTokens?; costUsd? }`), telemetry (`compactions` count, tokens saved), scoring finding `frequent-compaction`, `README.md`
- Test: beside files + property tests + integration

**Interfaces (binding):**
- `CompactionPolicy = { compactAt: 0.75; compactTo: 0.45; keepRecent: 4 (turns); minSavingTokens: 500 }` (fractions of usable budget, validated 0<compactTo<compactAt<=1).
- `planCompaction(params: { state: ContextMessage[]; policy; usableBudget: number; estimate }): CompactionPlan | undefined` returns undefined below `compactAt`; otherwise ordered stages until estimated tokens ≤ `compactTo × budget`: (1) **stub stale tool results** older than `keepRecent` turns, biggest first: replace the tool message text with `[result of <tool> call <id> omitted to save context (~N tokens); refetch with result_original handle <H>]`, keep the `tool` message (pairing intact), store original under a handle; (2) **drop exact duplicates** (identical tool results); (3) **summarise** the oldest compactable messages (everything except the last `keepRecent` turns) into ONE structured summary (`goal`, `decisions`, `facts`, `open items`, `tool outcomes`) using `compactionModel` (default: the agent's model) via the provider path (scheduler/resilience apply), merging the previous summary into the new one (single summary message always).
- Pairing rule: a unit of compaction is a *turn group* (assistant message with tool calls + its tool results); groups are summarised/stubbed atomically; the last `keepRecent` groups and any group with pending (unanswered) calls are untouchable.
- `applyCompaction(state, plan, summaryText)` returns the new state with the **hoist**: all non-compactable messages (including those accrued since last compaction) in stable chronological order, then the one summary, then retained recent compactable messages; assigns new `seq`s but keeps ids; returns the new prefix. Never reorders compactable relative order; never alters non-compactable content.
- Safety: compaction runs only at turn boundaries (after all tool results of the previous turn are in); serialised per run (a boolean guard + queue key per run); skipped when the run can finish within budget (estimated remaining turns ≤ 1 and estimate < usable budget); if after all stages estimate still > usable budget ⇒ throw `context_overflow` (new `AigentErrorCode`) with sizes in `details`; if the non-compactable block alone exceeds 60% of budget ⇒ warning event; if it exceeds 90% ⇒ `context_overflow` ("non-compactable context too large").
- Summariser prompt is a fixed constant (tested); summariser usage/cost is added to run totals under `usage.compactionTokens`; failure of the summariser call ⇒ fall back to stubbing-only plus a warning; if still over budget ⇒ `context_overflow`.
- Events: one `compaction` event per stage applied; the stored `summary` message has `kind: 'summary'`.

- [ ] **Step 1: Failing tests**: policy validation; planner thresholds + hysteresis (fires at ≥75%, lands ≤45%, no thrash: simulate 200 small messages ⇒ compactions count bounded); stub format and pairing intact; duplicates dropped; summarise stage uses FakeProvider (assert prompt contains old summary + old messages, new single summary); property test (fast-check) over random histories/flags/compaction counts: non-compactable messages survive byte-identical in chronological order, exactly ≤1 summary, tool call/result pairs never split, `keepRecent` groups verbatim; prefix hash unchanged between compactions and changes exactly at compaction; breakpoints after hoist; mid-tool-round never compacts (scripted: pressure during tools ⇒ compaction waits until results are in); overflow errors (compaction can't help; non-compactable too big); summariser failure fallback; skipped when finishing; `compaction` events; usage counters; serialised per run; integration run with tiny `contextSize` completes a 30-turn scripted task with several compactions and a final correct answer; resume of stubs via `result_original` handle (if shaper slice registered it) returns the original.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: token-pressure compaction with stubs, dedupe, single summary and safe hoisting`.

---

### Task 2: Compressor interface, static and dynamic compression, preview

**Files:**
- Create: `src/compression/compressor-types.ts`, `src/compression/compress-text.ts`, `src/compression/protect.ts`, `src/compression/compression-cache.ts`, `src/compression/fake-compressor.ts` (exported from `testing`), `src/compression/eval-compression.ts`, `src/core/preview.ts`
- Modify: `src/core/agent-types.ts` (`compression?: CompressionOptions`, `Agent.preview(input?)`), `src/core/create-aigent.ts`, `src/core/system-prompt.ts`/`task-brief.ts` (apply per-field compression at definition/call time with cache), `src/core/agent-version.ts` (compression settings and compressor id/version in hash), `src/shapers` hook for `compressible` tool results (dynamic), telemetry (tokens saved/ratio/latency per compression), `src/testing/index.ts`, `README.md` (including how a LLMLingua-2 plugin would implement `Compressor`, honest that none ships)
- Test: beside files

**Interfaces (binding):**
- `Compressor = { id: string; version: string; compress(input: { text: string; targetRatio: number; protect: string[]; signal?: AbortSignal }): Promise<{ text: string }> }`. `CompressionOptions = { compressor: Compressor; targetRatio?: number (default 0.5); minTokens?: number (default 200); fields?: { persona?: boolean; skillset?: boolean; context?: boolean; task?: boolean; references?: boolean; examples?: boolean }; applyTo?: ('toolResults' | 'history' | 'retrieval')[]; forceKeep?: string[] }` — defaults: `persona` and `skillset` **off**, `context`/`task`/`references` on when a compressor is configured.
- `compressText(params): Promise<CompressedText>` → `{ text; originalText; originalTokens; compressedTokens; ratio; cacheHit: boolean; key }`; cache key = sha-256(`source + compressor.id + compressor.version + canonical params`), stored in collection `compressed`; below `minTokens` ⇒ unchanged; output verified: every protected span from `findProtectedSpans(text)` (negation/modal words not|never|no|must|only|don't|shall|cannot, numbers+units, file paths, identifiers camelCase/snake_case/Pascal, quoted strings, URLs, code spans and fenced blocks, JSON objects) must still appear in the output — a compressor that drops one ⇒ result rejected, original used, warning emitted (`Compression of <field> dropped protected content and was ignored`). Never compressed regardless of options: questions/answers, plan/todo/directive records, the library's directive syntax, tool JSON schemas, code/diff/JSON results unless the tool sets `compressible: 'allow-code'`.
- Static content (persona, skillset, context, task text, references, examples) is compressed once at agent creation (`await` inside `ai.agent` is not possible synchronously ⇒ **compression happens lazily on first `task()` and is memoised on the agent**; the cache makes later agents/instances reuse it); dynamic content: tool results with `Tool.compressible` and `applyTo` including `toolResults` are compressed when committed to history (stored compressed, original kept by handle).
- `agent.preview(input?: TaskInput): Promise<PromptPreview>` where `PromptPreview = { system: string; brief: string; tools: ProviderToolSpec[]; fields: { field; original: string; final: string; originalTokens; finalTokens; compressed: boolean }[]; totalTokens }` — the exact text the model would see for that input (no provider call).
- `evalCompression({ agent, tasks, compressor }): Promise<CompressionEvalReport>` runs each task with and without compression using the agent's provider (FakeProvider in tests) and reports per-task status/answer equality, criteria equality, tokens saved, latency; pure harness.
- `fakeCompressor({ dropEvery?: number })`: deterministic (removes every Nth word except protected spans) for tests; `createBrokenCompressor` helper that drops negations to test the rejection.
- Telemetry: per compression `{ field, originalTokens, compressedTokens, ratio, latencyMs, cacheHit }` in the run record; `Report` finding `compression-net-negative` when success rate with compression is below baseline or latency cost exceeds savings.

- [ ] **Step 1: Failing tests**: protected-span detection table; compression determinism (second call is a cache hit and byte-identical; changing compressor version/params/source ⇒ new key and new agent version hash); protected tokens survive (property test with the fake compressor over random text with injected protected spans); rejection path with the broken compressor; per-field defaults (persona/skillset off); minTokens skip; never-compressed categories untouched (directive text, tool schemas, questions/answers); prefix hash stable across turns and across two agent instances sharing the store; `preview()` shows exact system/brief text matching what the FakeProvider receives (assert equality with the recorded first request); dynamic compression of a `compressible` tool result with original handle; telemetry fields; `evalCompression` on fixtures; plugin absence ⇒ behaviour unchanged (existing suites untouched).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: compressor interface, cached static/dynamic compression, preview and eval harness`.

---

## Self-review

Coverage: flags + layout + breakpoints (T0), compaction (T1), compression + preview (T2). LLMLingua itself and the spike are intentionally not implemented (needs downloads); the interface and a documented adapter recipe are. Names: `ContextMessage`, `CompactionPolicy`, `CompactionPlan`, `Compressor`, `CompressionOptions`, `PromptPreview`.
