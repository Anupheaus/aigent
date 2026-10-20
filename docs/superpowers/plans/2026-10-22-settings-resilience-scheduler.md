# Model Settings, Resilience and Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** First-class model settings resolved task > agent > runtime > provider and mapped per provider; an agent version hash; retry/timeout/fallback for provider calls; a shared scheduler (concurrency, RPM/TPM, priority lanes, fairness, 429 adaptation, cancellation) used by every agent.

**Architecture:** Settings are plain data on `ProviderRequest`; adapters map what they support and report the rest as warnings. Resilience is a small pure `streamWithResilience` used by the turn runner (retry only before the first event is yielded; fallback models afterwards). The scheduler is a standalone injectable module with a fake-clock-friendly design; the turn runner acquires a lease around each provider stream.

**Tech Stack:** TypeScript strict ESM, vitest, fast-check. Nothing new to install.

**Spec:** master plan sections "Model settings, context size and compaction", "Shared rate limiting and fair scheduling", "Agent versioning", "Gap-analysis decisions (provider resilience)" in `docs/design/master-plan.md`; foundation spec `docs/superpowers/specs/2026-10-20-phase-1-foundation-design.md`.

## Global Constraints

Same as `docs/superpowers/plans/2026-10-20-phase-1-foundation.md` Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: no network; time and randomness are injected (`Clock`, a `sleep(ms, signal)` function, a `random(): number`) so tests are deterministic and fast; every timer/listener is cleaned up (leak tests); new events/results are added to the public types and README.

## Review Focus

1. A retry must never replay after any event was yielded to the consumer (no duplicated text/tool calls); only pre-first-event failures retry.
2. Abort during backoff sleep, while queued in the scheduler, or while holding a lease must settle promptly, release the lease, and leave nothing queued.
3. Scheduler under load: concurrency cap never exceeded, per-minute budgets never exceeded in any sliding window, interactive before background but background never starved forever, one noisy agent cannot starve others.
4. Settings that a provider cannot honour must warn (event) and be dropped, never sent; invalid values rejected at definition time with precise errors.
5. The version hash must be stable across key order and unaffected by instanceId/name-independent runtime state, and must change when any behaviour-relevant field changes.

---

### Task 0: Model settings and agent version hash

**Files:**
- Create: `src/core/model-settings.ts`, `src/core/resolve-model-settings.ts`, `src/core/agent-version.ts`
- Modify: `src/providers/provider-types.ts` (add `ProviderSettings`, `ProviderRequest.settings?`, `ProviderCapabilities.supportedSettings`), both adapters + their message/request builders, `src/core/agent-types.ts` (`modelSettings`, `version`), `src/core/task-input.ts` (`modelSettings`, `priority`), `src/core/run-turn.ts` / `create-aigent.ts` (resolve and pass; emit `warning` for dropped settings), `src/testing/fake-provider.ts` (records settings, declares all supported)
- Test: `*.tests.ts` beside each new file and extend adapter tests

**Interfaces:**
- `ModelSettings = { contextSize?: number; maxOutputTokens?: number; temperature?: number; topP?: number; thinking?: 'off' | 'on' | { budgetTokens: number }; effort?: 'low' | 'medium' | 'high' | 'max'; showThinking?: boolean; promptCaching?: boolean; stop?: string[]; seed?: number; providerOptions?: Record<string, unknown> }` validated by a zod schema `modelSettingsSchema` (positive ints, temperature 0..2, topP 0..1, stop max 4 non-empty strings, budgetTokens ≥ 1024 for thinking) with precise `invalid_definition`/`invalid_input` errors.
- `resolveModelSettings(layers: ModelSettingsLayers): ModelSettings` with `ModelSettingsLayers = { task?: ModelSettings; agent?: ModelSettings; runtime?: ModelSettings; provider?: ModelSettings }`, field-by-field precedence task > agent > runtime > provider (a layer's `undefined` falls through; `providerOptions` shallow-merged with higher layers winning).
- `ProviderSettings = Omit<ModelSettings, 'contextSize' | 'showThinking'>` is what adapters receive (`ProviderRequest.settings`). `ProviderCapabilities.supportedSettings: (keyof ProviderSettings)[]`.
- `computeAgentVersion(input: AgentVersionInput): string` returns a lowercase hex sha-256 of canonical JSON (keys sorted recursively, `undefined` dropped) of `{ libraryVersion, model, persona, skillset, context, modelSettings, limits, version label, tools: [{ name, description, jsonSchema, strict, deterministic, cache, cacheTtlMs, hasSideEffects, timeoutMs, maxResultTokens }] sorted by name }`. `AgentVersionInput` excludes `name` and `instanceId`. `AGENT_LIBRARY_VERSION` constant read from `package.json` at build time is NOT possible in ESM without JSON import assertions; use a hand-maintained `LIBRARY_VERSION = '0.0.1'` constant in `src/core/library-version.ts` with a test asserting it equals `package.json` `version`.
- `Agent` gains `agentVersion: string`. `AgentDefinition` gains `modelSettings?: ModelSettings` and `version?: string` (human label). Run records (the `runs` collection) gain `agentVersion`, `model`, `settings` (the resolved settings), `version`.

Adapter mapping (binding):
- OpenAI-compatible: `temperature`, `top_p`, `max_tokens` (from `maxOutputTokens`), `stop`, `seed`, `reasoning_effort` (from `effort`: low/medium/high; `max` → `high`; only when `thinking !== 'off'` and effort set), `providerOptions` shallow-merged into the body last. `thinking`/`promptCaching` unsupported → dropped with a warning. `supportedSettings: ['maxOutputTokens','temperature','topP','stop','seed','effort','providerOptions']`.
- Anthropic: `temperature`, `top_p`, `max_tokens`, `stop_sequences`, `thinking` (`'on'` → `{ type: 'enabled', budget_tokens: min(maxOutputTokens - 1, 8000)` if `maxOutputTokens` known else 8000`}`, `{budgetTokens}` → that, `'off'` → omitted); with thinking enabled `temperature` must be dropped with a warning (Anthropic requires 1); `effort` → thinking budget when no explicit `thinking`: low 2048, medium 8000, high 16000, max 32000 (ensuring `max_tokens` > budget by raising `max_tokens` to budget + 1024 when needed); `promptCaching` overrides the adapter option; `seed` unsupported (warn); `providerOptions` shallow-merged into body last. 
- Dropped settings are reported by the adapter via a returned list; the plumbing: `Provider.stream(request, signal)` stays the same, so adapters expose a pure `unsupportedSettings(settings): string[]` check and the turn runner computes the warning from `capabilities.supportedSettings` BEFORE the call (`"Provider 'x' does not support setting 'seed'; ignored"`), then strips those keys from `request.settings`.

Post-review amendments (`.superpowers/sdd/2026-10-22-settings-resilience-scheduler/final-review.md`), superseding the binding table above where they differ:
- Providers' checks receive the model: `unsupportedSettings(settings, { model })`, plus an optional `settingsWarnings(settings, { model }): string[]` for notes on kept settings (I2b, I4).
- Anthropic (I2, I2b): `topP` is dropped when `temperature` is also set, and while thinking when below 0.95. `effort` (like `'on'`) picks a budget of `max(1024, min(maxOutputTokens - 1, effortBudget))`, so `maxOutputTokens` holds; when a budget still forces `max_tokens` above it, `settingsWarnings` says so.
- OpenAI-compatible (I3): `tokenLimitField` option (`max_tokens` default, `max_completion_tokens` for the `openai` preset); `isReasoningModel(model)` option (the `openai` preset matches `o<digit>` and `gpt-5`): reasoning models drop `temperature`, `topP` and `stop`, other models drop `effort`; without a matcher, sending `reasoning_effort` drops `temperature`, `topP` and `stop`.
- `providerOptions` (I4) is keyed by provider id and merged per provider across layers; each target receives only its own entry. Adapters never let it replace a field they set (core fields and every mapped setting); such keys are dropped with a `settingsWarnings` warning.

- [ ] **Step 1: Write failing tests**: schema accept/reject table; resolve precedence incl. fall-through and providerOptions merge; version hash stable under key order and tool order, changes on each field, ignores name/instanceId; library-version equals package.json; adapter request bodies for each mapping rule (OpenAI and Anthropic, including the thinking/temperature interplay and the effort→budget→max_tokens raise); unsupported settings produce one `warning` event each and are not sent; run record contains `agentVersion`, `model`, resolved `settings`; `createAigent` rejects invalid settings at agent creation (agent level) and `task()` (task level).
- [ ] **Step 2: Run to verify failure.** [ ] **Step 3: Implement.** [ ] **Step 4: Full suite + typecheck + build.**
- [ ] **Step 5: Commit** `feat: model settings, resolution, provider mapping and agent version hash`.

---

### Task 1: Retry, timeout and fallback

**Files:**
- Create: `src/core/stream-with-resilience.ts`, `src/core/resilience-policy.ts`
- Modify: `src/core/run-turn.ts`, `src/core/agent-types.ts` (`resilience?`, `fallbackModels?`), `src/core/create-aigent.ts` (resolve fallback providers at agent creation), `src/core/runtime-services.ts` (add `Sleeper` and `RandomSource` services with defaults), adapters (surface `details.retryAfterMs` parsed from the `retry-after` header — seconds or HTTP date — via `failedResponseError`)
- Test: `src/core/stream-with-resilience.tests.ts`, `src/core/resilience-policy.tests.ts`, adapter tests for `retryAfterMs`

**Interfaces:**
- `ResiliencePolicy = { maxRetries: number; baseDelayMs: number; maxDelayMs: number; firstEventTimeoutMs?: number; jitter: number }` with defaults `{ maxRetries: 2, baseDelayMs: 500, maxDelayMs: 20_000, jitter: 0.2 }` and `AgentDefinition.resilience?: Partial<ResiliencePolicy>`; `AgentDefinition.fallbackModels?: string[]` (`provider:model` strings, resolved like `model`).
- `computeBackoffMs(params: { attempt: number; policy: ResiliencePolicy; retryAfterMs?: number; random(): number }): number` = `min(maxDelayMs, max(retryAfterMs ?? 0, baseDelayMs * 2 ** attempt))` times `(1 + jitter * (random()*2 - 1))`, never below `retryAfterMs`.
- `isRetryable(error: unknown): boolean`: `AigentError` `provider_failed` with `details.retryable === true`; never `aborted`.
- `streamWithResilience(params: ResilientStreamParams): AsyncIterable<ProviderEvent>` where `ResilientStreamParams = { attempts: ProviderAttempt[]; policy; sleep(ms, signal): Promise<void>; random(): number; signal: AbortSignal; onRetry?(info: RetryInfo): void; firstEventTimeoutMs? }` and `ProviderAttempt = { label: string; open(signal: AbortSignal): AsyncIterable<ProviderEvent> }` (primary then fallbacks). Behaviour: for each attempt, up to `maxRetries` retries on retryable failures **before any event was yielded** (sleep with backoff, abortable; call `onRetry`); if `firstEventTimeoutMs` elapses with no event, abort that attempt and treat as retryable failure `provider_failed` (`details.retryable: true`, `details.timeout: true`); a failure after the first event is yielded is rethrown immediately (no retry, no fallback); when an attempt's retries are exhausted or its error is non-retryable (e.g. 401/400) the next attempt (fallback model) is tried when the error is `provider_failed` and, for non-retryable errors, only if `policy` allows (`fallbackOnNonRetryable: false` by default; 5xx/429/timeouts always fall back after retries); abort at any point (during sleep, during open) throws `aborted` promptly and cancels the inner iterator.
- Turn runner emits `{ type: 'retry'; attempt: number; delayMs: number; model: string; reason: string }` and `{ type: 'fallback'; from: string; to: string; reason: string }` events (add to `AigentEvent`, README). Run totals count only the attempt that produced events; `TaskResult` gains `usage.retries` and `usage.fallbacks` counts (and run record).

- [ ] **Step 1: Write failing tests** with a scripted attempt list, fake `sleep` recording delays and honouring the abort signal, and seeded `random`: backoff table (monotonic, capped, jitter bounds, retry-after floor); retry then success; retries exhausted → fallback attempt used; non-retryable 401 no retry and no fallback by default; failure after first event not retried; first-event timeout retries; abort during backoff sleep settles quickly with no further attempts; abort mid-open; inner iterator `return()` called on abandon (leak test); property test: for any scripted sequence of pre-event failures the number of opens ≤ (maxRetries+1) × attempts and consumer-visible events never duplicate; end-to-end via `createAigent` with FakeProvider variants (a `failWith` turn option): `retry`/`fallback` events, usage counters, run completes; adapters parse `retry-after` seconds and date formats.
- [ ] **Step 2: Run to verify failure.** [ ] **Step 3: Implement** (`FakeTurn` gains `failBeforeEvents?: AigentError` for scripted failures — extend `src/testing/fake-provider.ts` and its tests). [ ] **Step 4: Full suite + typecheck + build.**
- [ ] **Step 5: Commit** `feat: provider retry, first-event timeout and model fallback`.

---

### Task 2: Shared scheduler

**Files:**
- Create: `src/scheduler/scheduler.ts`, `src/scheduler/scheduler-types.ts`, `src/scheduler/token-bucket.ts`, `src/scheduler/index.ts` is NOT created (barrel is `src/index.ts`)
- Modify: `src/core/create-aigent.ts` (option `scheduler?: Scheduler | SchedulerOptions`, default: an unlimited pass-through scheduler so existing behaviour is unchanged), `src/core/run-turn.ts` (acquire a lease around each provider attempt; emit `queued` activity), `src/core/aigent-events.ts` (`{ type: 'queued'; position: number; reason: 'concurrency' | 'requests-per-minute' | 'tokens-per-minute'; waitMs?: number }`), `src/core/task-input.ts` (`priority: 'interactive' | 'background'`, default `unattended ? 'background' : 'interactive'`), `README.md`
- Test: `src/scheduler/scheduler.tests.ts`, `src/scheduler/token-bucket.tests.ts`, integration in `create-aigent.tests.ts`

**Interfaces:**
- `SchedulerOptions = { limits?: Record<string, ProviderLimits>; defaultLimits?: ProviderLimits; clock: Clock (default system); sleep; maxBackgroundWaitMs?: number }` and `ProviderLimits = { maxConcurrent?: number; requestsPerMinute?: number; tokensPerMinute?: number }`. Keys are provider ids (or `provider:model` for model-specific limits; most specific wins).
- `Scheduler = { acquire(request: LeaseRequest): Promise<Lease>; reportRateLimit(params: { key: string; retryAfterMs: number }): void; reportUsage(params: { key: string; tokens: number }): void; snapshot(): SchedulerSnapshot }`, `LeaseRequest = { key: string; estimatedTokens: number; priority: 'interactive' | 'background'; agentName: string; signal: AbortSignal; onQueued?(info: QueuedInfo): void }`, `Lease = { release(actual?: { tokens: number }): void }` (idempotent release).
- Semantics: a request is admitted when concurrency < max, the requests-per-minute and tokens-per-minute budgets (token buckets with continuous refill, using `clock`) have room for it, and no rate-limit pause is active for the key. Queue order: interactive lane before background lane; within a lane, fair round-robin across `agentName` (a noisy agent with 100 queued requests cannot delay another agent's first request by more than one admission); background requests waiting longer than `maxBackgroundWaitMs` (default 60_000) are promoted to the interactive lane (no starvation). `reportRateLimit` pauses the key for `retryAfterMs` and temporarily halves its effective concurrency for the next 10 admissions. Abort: queued requests are removed immediately and reject with an `aborted` AigentError (no budget consumed); releasing a lease frees concurrency; `release({tokens})` reconciles estimated vs actual tokens in the bucket. `snapshot()` returns queue lengths and in-flight counts per key. The turn runner estimates tokens as `ceil(JSON.length / 4) + maxOutputTokens ?? 1024`, passes 429 `retryAfterMs` from provider errors to `reportRateLimit`, and releases with actual usage.
- Cross-process token bucket is out of scope here (interface leaves room: `Scheduler` is an interface).

- [ ] **Step 1: Write failing tests** with a fake clock + fake sleep (deterministic): concurrency cap never exceeded under 200 mixed requests (property test with random durations, tracked max in-flight); RPM/TPM never exceeded in any sliding 60 s window (assert by recording admission times); interactive-before-background ordering; fairness (agent A floods 50, agent B's single request admitted within the next admission); background promotion after `maxBackgroundWaitMs`; abort while queued removes the request, rejects `aborted`, consumes no budget; double release harmless; `reportRateLimit` pause and halved concurrency; `snapshot`; most-specific limit key wins; default pass-through scheduler imposes no waiting; integration: two agents with `maxConcurrent: 1` run tasks concurrently and the second sees a `queued` event, `queued` events not emitted when admitted immediately, leases released on completion, cancel and provider failure (no leak: snapshot in-flight 0 afterwards).
- [ ] **Step 2: Run to verify failure.** [ ] **Step 3: Implement.** [ ] **Step 4: Full suite + typecheck + build + pack check.**
- [ ] **Step 5: Commit** `feat: shared scheduler with limits, lanes, fairness and rate-limit adaptation`.

---

## Self-review

Spec coverage: settings and hash (T0), resilience (T1), scheduler (T2). Cross-process bucket deferred by design. Types named consistently: `ModelSettings`, `ProviderSettings`, `ResiliencePolicy`, `Scheduler`, `Lease`, `LeaseRequest`, `ProviderLimits`.
