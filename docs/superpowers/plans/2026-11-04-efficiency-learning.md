# Efficiency, Strategy Learning and Skill Learning Implementation Plan (Phases 3-5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Use the recorded data to make agents cheaper and better over time, safely: (3) model routing and an opt-in LLM response cache; (4) strategy variants (prompt/tool-guidance) selected by outcome with guarded rollout and automatic revert; (5) distilled reusable skills (composed tools) created from recurring successful traces, validated by replay and promoted only through an explicit approval workflow.

**Architecture:** All three phases are pure consumers of run records, traces, feedback and memory. Decisions are explainable records (`Decision { chose, because, alternatives, evidence }`) stored with the run. Variant and skill objects are versioned data included in the agent version hash. A seeded random source makes bandit choices reproducible in tests. Learning never changes behaviour without enough evidence and never bypasses guardrails, approvals or policies: a skill is just a tool that runs other tools through the normal dispatcher.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check. Nothing new to install.

**Spec:** master plan phases 3, 4, 5 and "Efficiency", "Request-level analysis… tool suggestions" in `docs/design/master-plan.md`; telemetry/feedback, memory, cache plans.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: learning is **off by default** and opt-in per agent; user verdicts outrank agent-claimed outcomes in every statistic; every automatic change is recorded, explainable and reversible; minimum-sample and significance guards before any switch; no learning from `disableTelemetry` runs or runs marked incorrect; no network.

## Review Focus

1. Safety of rollout: a variant/router/skill that performs worse is detected and reverted automatically within the configured window; a single lucky/unlucky run never flips a decision (minimum samples, confidence bounds), property-tested with simulated outcome streams.
2. Exploration is bounded (max share of traffic to unproven variants, never for `priority: 'quality'` tasks or unattended-critical flags) and reproducible with a seed.
3. Response cache correctness: only exact-match, temperature-0/seeded, tool-free-or-fully-cached requests; never serves across different settings/agent versions; stale TTL honoured; side-effect turns never cached.
4. Skills: replaying a skill on recorded fixtures reproduces recorded results (validation gate), skills cannot exceed the permissions of the tools they compose, argument binding cannot inject (values are data), failures inside a skill are reported per step with the standard envelope, and an unapproved skill is never active.
5. Everything learned is inspectable and removable (`ai.learning.*` APIs), and removing it restores baseline behaviour exactly (prompt byte-equality test).

---

### Task 0: Routing and response cache (Phase 3)

**Files:**
- Create: `src/routing/model-router.ts`, `routing-types.ts`, `task-features.ts`, `bandit.ts`, `routing-stats.ts`, `src/cache/response-cache.ts`
- Modify: `src/core/agent-types.ts` (`model: string | ModelRoutes`; `ModelRoutes = { default: string; cheap?: string; capable?: string; fallback?: string[] }`), `src/core/task-input.ts` (`priority: 'speed' | 'cost' | 'quality'` already planned — wire it), `src/core/create-aigent.ts` (`learning?: { routing?: RoutingOptions; responseCache?: ResponseCacheOptions }`, `ai.learning.routing.*`), `src/scoring/*` (decision evidence reuse), README
- Test: beside + simulation tests

**Interfaces (binding):** `extractTaskFeatures(input): TaskFeatures` (length bucket, has plan, #acceptance criteria, has output schema, tool count, unattended, label, keyword classes: search/edit/analyse/summarise via simple deterministic lexicon). `createModelRouter(options): ModelRouter` with `choose(params: { agentName; agentVersion; features; priority; routes; now }): Promise<RouteDecision>` where `RouteDecision = { model: string; reason: 'default'|'priority-quality'|'priority-cost'|'learned'|'explore'; evidence?: {...}; alternatives: { model; successRate; meanCostUsd; n }[] }`. Learning: per (agent, featureBucket, model) stats from run records (success = user verdict correct, else agent outcome success AND status completed; weights user>agent), UCB1 with success-rate minus cost penalty (`costWeight` option) after `minSamples` (default 20) per arm; before that `default`; `priority: 'quality'` always capable/default, `'cost'` prefers cheap when its lower confidence bound ≥ `minSuccessRate` (default 0.85) of the best; exploration share ≤ `maxExploration` (default 0.1) via seeded `random`; auto-revert: if a learned choice's recent window (last 30) success drops > `revertDrop` (default 0.1) below its earlier mean ⇒ `learned` disabled for that bucket for `cooldownRuns`. Decisions recorded on the run record (`route`). `ResponseCache` (opt-in `responseCache: { ttlMs, maxEntries }`): key = sha-256 of canonical `{ providerId, model, resolved settings, messages, tools, agentVersion }`; only when `settings.temperature === 0 || seed != null`, request has no tools OR all tools deterministic+cache, and the previous turn had no side effects; stores full event arrays; returns recorded events (usage reported with `cachedResponse: true` and zero cost); never caches errors/aborted; scope per agent instance unless `shared: true`.

- [ ] **Step 1: Failing tests**: features table; bandit with simulated Bernoulli arms (seeded) converges to the best arm within N runs with bounded regret (assert regret bound statistically with fixed seeds); min-samples guard; priority overrides; exploration cap; revert on simulated degradation; decisions recorded; cache hit/miss matrix (temperature, tools, side effects, settings change, agent version change, TTL); cache hit reports zero cost and `cachedResponse`; route precedence with fallback models from slice 3.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: learned model routing with guarded rollout and opt-in response cache`.

---

### Task 1: Strategy learning (Phase 4)

**Files:**
- Create: `src/learning/strategy-types.ts`, `strategy-store.ts`, `variant-selector.ts`, `apply-variant.ts`, `rollout-guard.ts`, `lessons.ts`
- Modify: `src/core/create-aigent.ts` (`ai.learning.strategy`), `src/core/agent-version.ts` (active variant ids in hash), `src/core/system-prompt.ts`/`tool descriptions pipeline` (apply variant overlays), README
- Test: beside + simulation

**Interfaces (binding):** `StrategyVariant = { id; agentName; label; changes: VariantChange[]; status: 'candidate'|'trial'|'active'|'rejected'|'reverted'; createdAt; createdBy: 'consumer'|'suggested' }`, `VariantChange = { kind: 'tool-description'; tool; text } | { kind: 'system-rule'; text (≤400); position: 'after-rules' } | { kind: 'tool-order-hint'; tools: string[] } | { kind: 'batching-hint'; text }` — only these additive, prompt-level overlays (no code, no permission changes). Consumers register candidates (`ai.learning.strategy.propose(agentName, variant)`); the library may also **suggest** candidates from findings (e.g. `unbatched-repeats` ⇒ a batching-hint variant, `slow-tool` verbose ⇒ description tweak) as `candidate`s needing consumer approval to enter trial. Selection: for tasks of an agent in trial, assign the variant with probability `trialShare` (default 0.2) deterministically from `hash(runKey, seed)` so assignment is reproducible; outcomes compared per feature bucket with a two-proportion test + efficiency (tokens/turns) comparison; promotion to `active` requires `minSamples` (30/arm), significance (p<0.05 one-sided via normal approx, implemented in `stats.ts`) and no efficiency regression > 10%; rollout guard demotes `active` variants whose rolling success drops below the pre-promotion baseline minus tolerance (auto-revert, status `reverted`, recorded). Active variants are part of the agent version hash (so `compareVersions` works) and applied as deterministic overlays (sorted, byte-stable). `lessons`: for similar tasks (task grouping from analysis slice) with user-incorrect verdicts and expected answers, build short lessons surfaced via memory recall (no extra model call).

- [ ] **Step 1: Failing tests**: overlay application byte-stable and removable (prompt equality with no variants); selection determinism; significance function table vs known values; simulated A/B streams: better variant promoted, equal variant not, worse variant never promoted, degradation after promotion reverted; user verdict outranks agent claims in the stats; version hash changes with active variants; suggestion generation from fixture findings; consumer approval gating; `disableTelemetry`/incorrect runs excluded.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: strategy variants with guarded trials, promotion and automatic revert`.

---

### Task 2: Skill learning (Phase 5)

**Files:**
- Create: `src/learning/skills/skill-types.ts`, `distil.ts`, `skill-tool.ts`, `validate-skill.ts`, `skill-store.ts`, `skill-registry.ts`
- Modify: `src/core/create-aigent.ts` (`ai.skills.{list,get,approve,reject,retire,rollback}`; approved skills auto-registered as tools for agents with `skills: true`), `src/analysis/*` (expose mined sequences with arg bindings), README, AGENTS.md
- Test: beside + fixtures

**Interfaces (binding):** `Skill = { id; name (snake_case, `skill_` prefix); description; version: number; argsSchema: JSON schema (strict subset, derived: arguments that varied across supporting traces become parameters; constants are baked in); steps: SkillStep[]; preconditions: string[]; examples: { args; summary }[]; stats: { supportingRuns; replayPass; uses; successRate }; status: 'candidate'|'shadow'|'active'|'rejected'|'retired'; createdAt; agentName }`, `SkillStep = { tool: string; args: ArgTemplate (each value = `{ const } | { param: name } | { fromStep: index; path: string }`); onFailure: 'stop' | 'continue' }`. `distilSkills(params: { traces; minSupport: 3; maxSteps: 6 }): SkillCandidate[]` from mined sequences ending in successful outcomes: aligns arg values across supporting traces to decide const/param/fromStep bindings (value equality of earlier results → `fromStep`); refuses sequences containing side-effecting tools unless `allowSideEffects` and each such step requires approval at runtime (inherits tool approval policy). `validateSkill(candidate, traces)`: replay against recorded traces with a recorded-result tool double — every supporting trace must reproduce the same final result (replayPass = 1.0) and arg binding must not reference unknown params. Lifecycle: candidate → `shadow` (consumer approval; suggested in `ai.report().toolSuggestions` and shown to the model as an advisory hint only, never executed) → `active` (second approval; registered as tool `skill_*` executing steps sequentially **through the normal dispatcher** (so cache, guardrails, approvals, dry-run, undo, ledger, telemetry all apply), returning per-step envelopes and an aggregate outcome; `describeActivity` generated; `deterministic:false` unless all composed tools are deterministic; version bump on edits; `rollback(version)`; automatic retire when rolling success falls below threshold. Skills never exceed composed tools' permissions; param values are data (validated by each step's tool schema).

- [ ] **Step 1: Failing tests**: distillation from the "search → read → search → read" fixture ×4 produces the expected skill with correct const/param/fromStep bindings; refuses single-run/low-support sequences and side-effecting ones by default; validation replay gate (tampered trace fails); lifecycle transitions require approvals (no auto-activation); active skill executes via dispatcher with per-step envelopes; approvals/guardrails/dry-run apply to inner steps (dry-run skill ⇒ planned effects, no execution); failure semantics (`stop`/`continue`); versioning/rollback; auto-retire on degradation (simulation); skill tools appear sorted/stable in the prompt; removing all skills restores baseline prompt bytes; inspectable via `ai.skills.list`.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: skill distillation, validation and approved composed tools`.

---

## Self-review

Coverage: routing/response cache (T0), strategy (T1), skills (T2). Real-world gains need real data; here everything is verified by simulation and fixtures. Names: `ModelRouter`, `RouteDecision`, `StrategyVariant`, `Skill`, `SkillStep`.
