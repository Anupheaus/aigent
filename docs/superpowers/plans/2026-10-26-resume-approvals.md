# Resumable Instances, Checkpoints and Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** An agent instance can be restored by `instanceId` exactly as it was and any interrupted run, chat turn or open question continued without redoing side effects; plus a general human-approval mechanism usable by all packs.

**Architecture:** A `checkpoint` module writes versioned, append-only run/chat state records (with periodic snapshots) through the keyed write queue at every safe boundary. A call-ledger records each tool call's lifecycle (`started` → `done|failed`) with an idempotency key *before* execution. A store-backed lease with fencing tokens guarantees a single live owner. Resume replays from the last checkpoint using the identical prompt layout. Approvals are an awaited gate in tool dispatch with durable pending state.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check. Nothing new.

**Spec:** master plan sections "Resumable agent instances (must-have)", "Human approvals", "Determinism notes", resume verification bullets in `docs/design/master-plan.md`; slice plans so far (esp. chat, layout/compaction, cache/shapers) for the state that must be checkpointed.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: no network; clocks/ids injected; checkpoint records are schema-versioned with a migration hook; every checkpoint write goes through `redact` and the keyed write queue; a completed (`done`) tool call is NEVER executed again on resume; stale owners' writes are rejected by fencing.

## Review Focus

1. Crash-injection at EVERY boundary (mid-stream, between tool dispatch and result, mid-batch, between checkpoint and store write, mid-compaction, between approval request and decision) followed by resume must end with the same final state as an uninterrupted run, with a counting side-effect tool executed exactly the expected number of times.
2. Lease/fencing: two processes (simulated by two `createAigent` over one store) restoring one `instanceId`: the second gets `instance_locked`; after lease expiry it takes over and the first's late writes are rejected.
3. The prompt prefix after restore is byte-identical to what the original run would have sent (prefix hash asserted), including system text, tool specs, pinned blocks, summary, alias table and compressed text.
4. Restore bounded cost: restoring a session with 5k patches uses the latest snapshot plus tail, not the full log.
5. Approval gates never deadlock: deny paths, `unattended` runs (never wait), stop/cancel while pending, pending approvals surviving restart.

---

### Task 0: Checkpoint store, call ledger, lease

**Files:**
- Create: `src/resume/checkpoint-types.ts`, `src/resume/checkpoint-writer.ts`, `src/resume/checkpoint-reader.ts`, `src/resume/migrations.ts`, `src/resume/call-ledger.ts`, `src/resume/lease.ts`, `src/resume/fencing-store.ts`
- Modify: `src/store/store-types.ts` (no breaking change; helpers built on `compareAndSet`), README
- Test: beside each + property/crash tests

**Interfaces (binding):**
- `Checkpoint = { schemaVersion: 1; instanceId; runId?; sessionId?; seq: number; boundary: 'message'|'turn-complete'|'tool-batch-complete'|'directive'|'question'|'compaction'|'plan'|'approval'|'start'|'end'; at: number; fence: number; state: RunState | SessionState }` with `RunState` containing everything needed to rebuild a run: context messages (with flags), alias table JSON, compressed text keys, plan/todo state, totals, settings, agentVersion, volatile inputs (clock-independent), pending tool calls, open questions and approvals. Records are append-only in collection `checkpoints` (key `${instanceId}:${runId|sessionId}:${seq padded}`) with a full snapshot every N (default 25) checkpoints and pruning older than the latest snapshot beyond `retention.checkpoints` (default keep 2 snapshots); `readLatest(instanceId, runId)` loads latest snapshot + tail. `migrate(record)` upgrades older `schemaVersion`s (v1 only now; test with a fabricated v0 migrated to v1).
- `CallLedger`: `begin({ callId, tool, argsHash, idempotencyKey }) → LedgerEntry{status:'started'}` persisted BEFORE execution; `complete(callId, resultEnvelope)` / `fail(callId, error)`; `get(callId)`. Idempotency key = `${runId}:${callId}`; passed to tools in `ToolContext.idempotencyKey`.
- Tool declaration: `Tool.resume?: 'rerun' | 'verify' | 'ask' | 'skip'` (default: read-only tools (no side effects) `rerun`; side-effecting tools `ask`), `Tool.verify?(args, ctx): Promise<{ done: boolean; result?: unknown }>`; validated at definition (`verify` required when `resume: 'verify'`).
- `Lease`: `acquireLease({ store, instanceId, ownerId, ttlMs, clock }) → { fence: number; renew(); release() }` via `compareAndSet` on `leases/<instanceId>` (`{ ownerId, fence, expiresAt }`); heartbeat renewal timer (injected sleep); `instance_locked` AigentError when held and unexpired; takeover increments `fence`; `FencedStore` wrapper rejects writes whose fence is older than the stored lease fence with `store_conflict` (details `fenced: true`).

- [ ] **Step 1: Failing tests**: checkpoint round trip, snapshot cadence/pruning, tail replay equals full replay (property), migration v0→v1, ledger lifecycle and ordering guarantee (entry is durable before the tool runs: crash-inject at the callback), lease acquire/renew/expiry/takeover/fencing (two writers), heartbeat timer cleaned up on release (leak test), `verify` required validation.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: checkpoints, call ledger and fenced leases`.

---

### Task 1: Resume for runs and chats

**Files:**
- Create: `src/resume/restore-agent.ts`, `src/resume/resume-run.ts`, `src/resume/resume-chat.ts`, `src/resume/reconcile-calls.ts`, `src/resume/checkpoint-hooks.ts`
- Modify: `src/core/run-agent-turns.ts` (emit checkpoints at the listed boundaries via an injected `CheckpointHooks`), `src/core/dispatch-tool-call.ts` (ledger begin/complete), `src/core/create-aigent.ts` (`ai.restoreAgent(instanceId)`; `ai.agent({ ...definition, instanceId })` restores; `agent.resume({ runId? })`; lease acquisition option `lease: { ttlMs, ownerId? } | false`), `src/chat/*` (session checkpoints, resumable suspended `ask_user` turns replacing the earlier ruling), README
- Test: beside + crash-injection suite `src/resume/crash-injection.tests.ts`

**Interfaces (binding):**
- `agent.resume(options?: { runId?: string }): TaskRun | undefined` continues the latest interrupted run (status not terminal) from its last checkpoint: re-issues the pending model request with the identical prompt layout, re-delivers tool results that completed but were not consumed, and for calls in `started` state follows `Tool.resume`: `rerun` ⇒ run again; `verify` ⇒ call `verify` (done ⇒ synthesize the recorded/returned result, else rerun); `ask` ⇒ approval request (`approval-request` event, pending durable) or fail `unattended` with an `approval_denied`-style envelope the agent can see; `skip` ⇒ synthetic `skipped` envelope. Completed ledger entries are NEVER re-executed (counting-tool assertion). Open questions/approvals remain pending; a graceful-stopped task resumes from its preserved state.
- `ai.agent({ ...definition, instanceId })` loads persisted agent state (settings, summary/non-compactable block, alias table, usage totals, chat sessions index) and verifies `agentVersion`; mismatch ⇒ `warning` + new version recorded (restore proceeds). `chat({ sessionId })` restores session as before but now also resumes a suspended turn (ask_user) from checkpoint.
- Determinism: restore reproduces state, not model randomness. The prefix hash of the resumed request equals the original's.
- Crash-injection harness (`src/resume/crash-injection.test-support.ts`): wraps store/provider/tools so a throw (simulated crash) fires at the Nth occurrence of a named boundary; a test matrix runs every boundary × several N, restarts with a fresh `createAigent` on the same store, resumes, and asserts: same final answer/status as an uninterrupted control run; counting side-effect tool executed exactly once per logical call (for `rerun`-policy read-only tools at-least-once is allowed and asserted separately); no duplicate checkpoints seq; prefix hash equality; lease handoff.

- [ ] **Step 1: Failing tests**: the matrix above; restore snapshot equality (`conversation()` and run state field-by-field vs pre-crash snapshot); restore cost bounded (5k patches ⇒ reads snapshot + tail only, assert number of store reads); `instance_locked` and takeover; `resume()` of nothing returns undefined; unattended + `ask` policy; verify policy; skip policy; stopped-gracefully resume; chat suspended `ask_user` resumes after reopen and answer.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: resumable runs and chats with exactly-once tool effects`.

---

### Task 2: Approvals

**Files:**
- Create: `src/approvals/approval-types.ts`, `src/approvals/approval-gate.ts`, `src/approvals/approval-rules.ts`, `src/approvals/audit-trail.ts`
- Modify: `src/tools/tool-types.ts` + `define-tool.ts` (`requiresApproval?: boolean | ((args, ctx) => boolean) | ApprovalPolicy`, `risk?: 'low'|'medium'|'high'`), `src/core/dispatch-tool-call.ts`, `src/core/create-aigent.ts` (`approvals?: { allow?: ApprovalRule[]; deny?: ApprovalRule[] }`, `agent.approve(requestId, decision)`), `src/core/aigent-events.ts` (`approval-request`, `approval-decision`), README
- Test: beside + integration

**Interfaces (binding):** `ApprovalRule = { tool: string; when?: (args) => boolean | argsMatch: Record<string, string|number|boolean> }` (pre-granted rules apply first: deny beats allow). Gate flow in dispatch: if tool requires approval for these args ⇒ evaluate rules (deny ⇒ envelope `denied`/`approval_denied`; allow ⇒ proceed) else emit `approval-request` `{ requestId, callId, tool, argsSummary, risk, reason, activity: ToolActivityView }`, persist as pending (checkpoint boundary `approval`, non-compactable), await `agent.approve(requestId, { decision: 'allow_once'|'allow_always'|'deny', scope?: { tool?, argsMatch? }, note? })`; `allow_always` adds a runtime rule (scoped); `unattended` runs never wait (pre-granted or denied with structured `approval_denied` envelope + suggestion); stop/cancel while pending resolves the wait as denied/aborted and cleans up; every decision (including rule-based) appended to the audit trail collection `approvals` (`{ requestId, runId, tool, argsHash, decision, by: 'rule'|'user', at, note }`) through the queue + redact; survives restart (pending approvals restored; `agent.approve` after restore resolves the awaiting call on resume).

- [ ] **Step 1: Failing tests**: flag forms (boolean/function/policy); rule precedence table; allow_once vs allow_always scoping; unattended never waits; deny envelope shape visible to the model; pending survives restore and decision resumes; cancel while pending; audit trail completeness; multiple concurrent pending approvals resolved out of order; non-compactable flag; no deadlock under random decision orders (property test).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: human approvals with rules, audit trail and durable pending state`.

---

## Self-review

Coverage: checkpoints/ledger/lease (T0), resume (T1), approvals (T2). Guardrails and dry-run/undo are the next slice. Names: `Checkpoint`, `CallLedger`, `Lease`, `FencedStore`, `ApprovalRule`, `ApprovalDecision`.
