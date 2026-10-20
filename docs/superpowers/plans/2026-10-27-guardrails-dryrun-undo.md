# Guardrails, Dry-run and Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** A guardrail pipeline (built-ins on by default plus consumer hooks) at input / toolCall / toolResult / output / stream stages, a `dryRun` mode with simulated structured results and a planned-effects list, and recorded, reversible side effects with `agent.undo()`.

**Architecture:** Guardrails are pure async checks `(value, ctx) => allow | rewrite | block`, composed by a pipeline that is called from fixed points in the turn runner. Dry-run is a flag in `ToolContext` plus a per-tool `dryRun()` method; the dispatcher routes to it and refuses non-conforming mutating tools. Undo is an append-only effect log (per run) of `undo` closures' serialisable descriptors written through the checkpoint/ledger path; undo executes in reverse order with per-effect results.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check. Nothing new.

**Spec:** master plan sections "Guardrails (built-in + extensible)", "Side-effect safety: dry-run and undo" and their verification bullets in `C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`; slice plans so far (approvals, resume ledger, telemetry).

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: no network; guardrail blocks are structured results (`guardrail_blocked`) visible to the agent and as events; block-level guardrails fail CLOSED when they throw (configurable); guardrail decisions are stored and reported; untrusted content (tool results, files, web) can never widen permissions nor trigger directives.

## Review Focus

1. Secret/PII redaction at the `stream` stage must never leak a secret split across chunk boundaries (hold-back window), and must not mangle non-secret text; property test over random chunkings.
2. Prompt-injection fixtures in tool results ("ignore previous instructions…", fake `::aigent` lines, fake approval grants) cannot change tool permissions, approvals, or be executed as directives.
3. Dry-run: filesystem/in-memory-world snapshot is byte-identical after a dry-run for every mutating built-in test tool; a mutating tool without `dryRun()` is refused (fail closed), never silently executed.
4. Undo ordering and partial failure: effects reversed newest-first, a failing undo does not stop the rest, results are per effect, undoing twice is safe (idempotent `already_undone`), undo data retention honoured.
5. Guardrail pipeline ordering and cost: built-ins first then custom; a slow/throwing custom guardrail cannot hang a run (timeout, fail-closed/open per config).

---

### Task 0: Guardrail pipeline and built-ins

**Files:**
- Create: `src/guardrails/guardrail-types.ts`, `src/guardrails/define-guardrail.ts`, `src/guardrails/pipeline.ts`, `src/guardrails/stream-holdback.ts`, `src/guardrails/builtin/secrets.ts`, `pii.ts`, `scope.ts`, `injection.ts`, `loop-guard.ts`, `output-schema.ts`, `src/guardrails/builtin/index-builtins.ts` (not a barrel: exports `defaultGuardrails(options)`)
- Modify: `src/core/run-agent-turns.ts`/`dispatch-tool-call.ts` (call points), `src/chat/chat-engine.ts` (input stage), `src/core/create-aigent.ts` (`guardrails?: { builtins?: Partial<Record<BuiltinName, false | BuiltinOptions>>; custom?: Guardrail[]; failMode?: 'closed' | 'open'; timeoutMs?: number }`), `src/core/aigent-events.ts` (`guardrail` event), telemetry (decisions stored on steps/run; `guardrail` finding kind from scoring becomes live), README
- Test: beside + fixture corpora (`src/guardrails/fixtures.test-support.ts`)

**Interfaces (binding):**
- `Guardrail = { name: string; stage: 'input'|'toolCall'|'toolResult'|'output'|'stream'; blockLevel?: boolean; check(value: GuardrailValue, ctx: GuardrailContext): Promise<GuardrailDecision> | GuardrailDecision }`, `GuardrailDecision = { action: 'allow' } | { action: 'rewrite'; value: unknown; note: string } | { action: 'block'; reason: string; code: string }`. `defineGuardrail` validates name/stage. Pipeline runs built-ins (fixed order secrets → pii → injection → scope → loop-guard → output-schema) then custom in registration order (or `order` field), stops at first `block`, chains `rewrite`s, enforces `timeoutMs` (default 2000) per check; throwing/timeout ⇒ block when `blockLevel` or `failMode: 'closed'` else allow + warning.
- Blocks: `toolCall`/`toolResult` ⇒ envelope `{ ok:false, error:{ category:'denied', code:'guardrail_blocked', message, suggestion, details:{ guardrail, code } } }` (the agent sees why); `input`/`output` ⇒ result status `failed`-style `guardrail_blocked` error for input (run not started) and a replaced final answer + `warning` for output; every decision (non-allow) emits a `guardrail` event and is recorded (`guardrails: GuardrailDecisionRecord[]` on the trace step/run record).
- **Stream stage** (`createStreamHoldback`): visible text deltas pass through a hold-back buffer (default 64 chars, longest-possible-secret aware: holds back a trailing partial token that matches any secret prefix pattern) so a block/rewrite can retract before display; flushes at end; emitted `text-delta`s equal the checked text.
- Built-ins: `secrets` (API keys: `sk-…`, `AKIA…`, GitHub `ghp_`/`github_pat_`, Slack `xox[bap]-`, Google `AIza…`, JWTs, private key PEM blocks, connection strings with credentials `scheme://user:pass@host`, generic `password|secret|token\s*[:=]\s*\S{8,}`) ⇒ rewrite with `[REDACTED:<kind>]` in output, toolResult (and stream); `pii` (emails, phone numbers, card-like numbers passing Luhn, IBAN-like) with mode `'warn'|'redact'|'off'` (default warn on output, off on toolResult); `scope` (out-of-scope/skillset check: configured deny phrases/tool names from `outOfScope` and tool `allow/deny` lists ⇒ block planned tool calls whose tool is denied; output containing configured forbidden terms ⇒ warn); `injection` (heuristics on toolResult text: instruction-override phrases, fake system/assistant role markers, fake `::aigent` lines, fake tool-call JSON ⇒ **quarantine**: wrap in an inert, clearly-labelled data block and neutralise `::aigent` at line start with a zero-width marker so the directive parser never fires on tool-result content; never widens permissions); `loop-guard` (same tool+args ≥ N=4 times in a run ⇒ block with suggestion; runaway output over `maxOutputChars` ⇒ block/truncate); `output-schema` (validates the task's `output` zod schema when present — structured output retry loop is implemented here: failing validation feeds the issues back as a user message for up to `outputRetries` (default 2) turns, then fails with `output_invalid`; add `output?: z.ZodType`, `outputFormat?` to `TaskInput` and `TaskResult.output`).

- [ ] **Step 1: Failing tests**: each built-in vs positive/negative fixtures (no false positives on a corpus of ordinary code/text incl. hashes and UUIDs that must NOT be flagged as secrets); stream hold-back property test (secret split at every position never appears in emitted text; output text otherwise identical); injection fixtures (fake directives/approvals/permission-widening text inert; `::aigent status` inside a tool result never produces a directive event); pipeline order/rewrite chaining/first-block; timeouts and failMode; decisions recorded and visible to the agent in the envelope; custom guardrail via `defineGuardrail`; structured output validation + retry loop; disabling a built-in; no extra provider calls from guardrails.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: guardrail pipeline with secrets, pii, injection, scope, loop and output-schema built-ins`.

---

### Task 1: Dry-run

**Files:**
- Create: `src/effects/dry-run.ts`, `src/effects/planned-effects.ts`
- Modify: `src/tools/tool-types.ts` + `define-tool.ts` (`dryRun?(args, ctx): Promise<PlannedEffect[] | { result: unknown; effects: PlannedEffect[] }>`; validate that `hasSideEffects` tools may declare it), `src/core/dispatch-tool-call.ts`, `src/core/task-input.ts` + `chat` options (`dryRun?: boolean`), `src/core/aigent-events.ts` (`planned-effects`), result (`TaskResult.plannedEffects?`), system prompt line when dry-run (volatile section: "This is a dry run: results are simulated"), README
- Test: beside + integration with test tools

**Interfaces (binding):** `PlannedEffect = { tool; callId; kind: string (e.g. 'file.write'); target: string; summary: string; before?: string; after?: string (bounded) ; reversible: boolean }`. In dry-run: read-only tools run normally; mutating tools call `dryRun()` and return a clearly marked simulated envelope `{ ok: true, result: { simulated: true, effects: [...] } }`; a mutating tool WITHOUT `dryRun()` is refused with `denied`/`dry_run_unsupported` envelope (fail closed) and the call is NOT executed; the planned-effects list accumulates in run state, is emitted as events and returned on the result and run record; dry-run runs set `disableTelemetry`-independent flag `dryRun` on records; the tool result cache is bypassed for mutating tools and never stores simulated results.

- [ ] **Step 1: Failing tests**: world-snapshot unchanged for every test mutating tool; refusal path; simulated marking visible to the model; effects list accuracy and ordering; read-only tools still execute; cache not poisoned by simulated results; chat dry-run; `aigent_multi`/batch propagate per item.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: dry-run mode with planned effects`.

---

### Task 2: Effect log and undo

**Files:**
- Create: `src/effects/effect-log.ts`, `src/effects/undo.ts`, `src/effects/undo-types.ts`
- Modify: `src/tools/tool-types.ts` + `define-tool.ts` (`undo?(args, result, ctx): Promise<UndoDescriptor | undefined>` returns a serialisable descriptor captured at execution time, and `applyUndo?(descriptor, ctx): Promise<UndoOutcome>`; both required together), `src/core/dispatch-tool-call.ts`, `src/core/create-aigent.ts` (`agent.undo(target)`; `undo: { retentionMs? }`), `src/telemetry` (`undoable` flag on steps), README
- Test: beside + integration

**Interfaces (binding):** after a successful mutating call the dispatcher captures `UndoDescriptor` (JSON; may reference managed backup handles in the consumer store/blob hook) and appends `{ effectId, runId, callId, tool, at, descriptor, status: 'available' }` to the effect log (collection `effects`, via queue, redact applied to descriptor text fields only when `redact` configured). `agent.undo(target: { callId } | { runId } | { since: number })` reverses recorded effects in reverse chronological order calling `applyUndo`; returns `UndoReport = { results: { effectId; callId; tool; status: 'undone'|'failed'|'unavailable'|'already_undone'|'expired'; message? }[] }`; failures never stop later effects; second undo ⇒ `already_undone`; expired by retention ⇒ `expired`; tools without undo ⇒ `unavailable`; effects visible in `ai.trace`/report as "can be undone"; undo itself is recorded as an effect-log entry (`kind: 'undo'`). Concurrent undo of the same run serialised by the write queue.

- [ ] **Step 1: Failing tests**: reverse order across 5 effects; partial failure (middle fails, others undone, report precise); idempotent second undo; retention expiry with fake clock; unavailable tools; `{since}` and `{callId}` targets; concurrent undo calls; descriptors survive store round trip and a fresh `createAigent`; trace flags.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: effect log and agent.undo`.

---

## Self-review

Coverage: guardrails (T0), dry-run (T1), undo (T2). The fs/shell/git/db packs will implement `dryRun`/`undo`/approvals. Names: `Guardrail`, `GuardrailDecision`, `PlannedEffect`, `UndoDescriptor`, `UndoReport`.
