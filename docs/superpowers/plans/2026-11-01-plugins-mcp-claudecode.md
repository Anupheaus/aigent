# Plugins, MCP and Claude Code Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** A generic, one-line plugin mechanism (`definePlugin`, `createAigent({ plugins })`, `ai.use`); built-in providers expressed through it; an MCP-consuming plugin that turns MCP server tools into strict aigent tools; and a **separate, unpublished** workspace package `@anupheaus/aigent-claude-code` that provides a delegated-loop Claude Code provider built on an injectable process/SDK boundary.

**Architecture:** A plugin is plain data (`name`, `version`, optional `providers`, `tools`, `stores`, `hooks`) validated with zod. Hooks are read-only observers by default. The MCP plugin talks JSON-RPC over an injectable `McpTransport` (stdio/streamable-HTTP implementations plus an in-memory pair for tests), tightens/rejects schemas into the strict subset, and wraps results in the standard envelope. The Claude Code package lives in `packages/claude-code` with its own `package.json`, depends on core only through the public API, and never reads credential files or tokens.

**Tech Stack:** TypeScript strict ESM, zod, vitest. No new runtime dependencies for core; MCP uses a minimal in-house JSON-RPC 2.0 client (stdio via `child_process`, HTTP via `fetch`). The Claude Code package takes `@anthropic-ai/claude-agent-sdk` as an optional peer, imported dynamically behind an interface; tests use fakes only. **Nothing is published; no real SDK/CLI is run in this slice** (the research spike is documented as pending and gated).

**Spec:** master plan sections "Claude Code subscription provider (no API key) — researched, with caveats", "MCP interop", "Plugins" verification bullets in `docs/design/master-plan.md`.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: the core package has NO dependency on any plugin package; plugin hook errors never crash a run; duplicate plugin/provider/tool names are rejected with precise errors; the Claude Code package must never read `~/.claude/.credentials.json`, keychain entries or any token, must strip `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the subprocess env only when explicitly asked to use subscription auth, and ships with a README stating the policy position (personal-use, not for distribution on behalf of other users) and is excluded from publishing (`"private": true`) until the user confirms the policy position.

## Review Focus

1. A plugin cannot widen permissions or replace core guards: hooks are observers (no mutation of args/results unless the plugin declares `hooks.mutating: true`, which is rejected unless the consumer opts in per plugin), and a throwing/slow hook never stalls or crashes a run.
2. MCP tool conversion: schemas not expressible in the strict subset are rejected or tightened with explicit, tested rules; consumer-set `deterministic`/`cache` flags default to `false`/`false`; results are envelope-wrapped; MCP errors, timeouts, malformed responses and server crashes become structured failures; the MCP process tree is cleaned up on `close()`; prompt injection in tool descriptions/results does not execute anything (descriptions are length-capped and sanitised).
3. Claude Code provider: tool_use interception semantic (our tools run in-process, the SDK loop never executes built-in tools), `ownsLoop: false` capability degrades features cleanly (no mid-stream dispatch guarantees; plan/todo injected via system prompt), usage mapped, abort kills the subprocess, env handling per the constraint above.
4. Conformance: the same provider contract suite passes for the plugin providers where applicable (with documented skips).

---

### Task 0: Plugin mechanism

**Files:**
- Create: `src/plugins/plugin-types.ts`, `src/plugins/define-plugin.ts`, `src/plugins/plugin-registry.ts`, `src/plugins/run-hooks.ts`
- Modify: `src/core/create-aigent.ts` (`plugins?: Plugin[]`, `ai.use(plugin)`), `src/providers/presets.ts` (re-express `anthropic`, `openAiCompatible`, `deepseek`, `openai`, `ollama` as `Plugin`s: `anthropicPlugin(options)`, etc. — existing factory functions remain), `src/core/aigent-events.ts` (no new event), README
- Test: beside + integration

**Interfaces (binding):** `Plugin = { name (kebab, unique); version: string; providers?: Provider[]; tools?: Tool[]; stores?: { id: string; store: Store }[]; hooks?: PluginHooks; mutating?: boolean }`, `PluginHooks = { onRunStart?(info); onToolCall?(info); onToolResult?(info); onRunEnd?(info); onError?(info) }` (info objects are deep-frozen copies, never the live objects); `definePlugin(plugin)` validates with zod (names, versions semver-ish, duplicate tool/provider names inside the plugin). Registry: provider ids resolved as `'<providerId>:<model>'`; plugin providers are namespaced only by their own `id` (collisions with existing ids ⇒ `invalid_definition` naming both sources); plugin tools are available to agents via `tools: [pluginTools('name')]` helper (tools are NOT auto-added to every agent); stores selectable with `createAigent({ store: 'plugin-store-id' })`. `runHooks` calls hooks sequentially per event with a 1000 ms timeout and error capture ⇒ `warning` events; mutating plugins are rejected unless `createAigent({ allowMutatingPlugins: ['name'] })`.

- [ ] **Step 1: Failing tests**: validation table; one-line wiring; duplicate rejection messages; hooks fire in order with frozen info (mutation attempts throw/ignored); throwing/hanging hook → warning, run completes; mutating gate; built-in provider plugins behave identically to the plain factories (existing provider tests run through the plugin form); `ai.use` after creation; plugin store selection; no plugin package imported by core (static scan test of `src/**` imports).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: plugin mechanism with providers, tools, stores and read-only hooks`.

---

### Task 1: MCP plugin

**Files:**
- Create: `src/mcp/json-rpc.ts`, `src/mcp/mcp-transport.ts`, `src/mcp/stdio-transport.ts`, `src/mcp/http-transport.ts`, `src/mcp/memory-transport.ts` (test pair, exported from `testing`), `src/mcp/mcp-client.ts`, `src/mcp/schema-to-strict.ts`, `src/mcp/mcp-tools.ts`, `src/mcp/mcp-plugin.ts`
- Modify: `package.json` exports `./mcp`, `src/testing/index.ts`, README
- Test: beside + `fake-mcp-server.test-support.ts` (in-memory server implementing initialize / tools/list / tools/call / notifications)

**Interfaces (binding):** `mcpPlugin(options: { servers: McpServerConfig[]; defaults?: { deterministic?: boolean; cache?: boolean; cacheTtlMs?: number; timeoutMs?: number; maxResultTokens?: number }; toolOverrides?: Record<string, Partial<ToolFlags>>; namePrefix?: 'server' | 'none' })`; `McpServerConfig = { name; transport: { type: 'stdio'; command; args?; env?; cwd? } | { type: 'http'; url; headers? } | { type: 'custom'; transport: McpTransport }; allowTools?: string[]; denyTools?: string[]; approvals?: boolean }`. The plugin connects lazily on first use (`await ai.ready()`), lists tools, and converts each: tool name `<server>__<tool>` (snake_case sanitised, ≤64), description capped at 1000 chars with control characters stripped, `inputSchema` ⇒ `schemaToStrict` (supports object/properties/required, string/number/integer/boolean/array/enum/const, nested objects; `additionalProperties:false` forced; optional props made nullable; rejects `oneOf/anyOf/allOf/$ref/patternProperties/additionalProperties:true`-open objects with a precise per-tool `skipped` report available via `plugin.report()` — or, when `strictSchema:false` is explicitly allowed per tool via `toolOverrides`, passes the loose schema through with `strict:false`). Flags: `deterministic:false, cache:false, hasSideEffects:true` by default (MCP tools are assumed mutating unless the consumer marks `readOnly` in `toolOverrides`, which also allows `cache`), `requiresApproval` per server `approvals`. Results: `content[]` text parts joined, image/resource parts as `binary-ref` summaries, `isError` ⇒ structured failure with the server's text; `contentKind:'prose'`, `fidelity:'verbatim'`; timeouts via `ToolContext.signal` and `notifications/cancelled`. `close()` terminates stdio processes (tree kill) and is called by `ai.close()`.

- [ ] **Step 1: Failing tests**: JSON-RPC framing (newline-delimited for stdio, incl. partial lines/large messages), request/response correlation, notifications, server crash mid-call ⇒ structured failure, malformed JSON-RPC ignored with warning; schema conversion table (accepted, tightened, rejected, loose override); name sanitising/collision handling; description sanitisation; flags/defaults/overrides; envelope + telemetry via the agent loop with the fake server; allow/deny lists; approvals; cache only when readOnly+cache; `close()` cleanup (leak test on fake transport + real `node` subprocess stdio server test written as a tiny script in the test); prompt-injection text in descriptions/results inert (guardrails integration).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: MCP consuming plugin`.

---

### Task 2: Claude Code package (unpublished)

**Files:**
- Create (new workspace package): `packages/claude-code/package.json` (`"name": "@anupheaus/aigent-claude-code"`, `"private": true`, peer `@anupheaus/aigent` workspace, optional peer `@anthropic-ai/claude-agent-sdk`), `packages/claude-code/tsconfig.json`, `packages/claude-code/src/index.ts`, `claude-code-plugin.ts`, `claude-code-provider.ts`, `sdk-boundary.ts` (interface `ClaudeAgentRunner` + dynamic SDK import wrapper), `tool-bridge.ts` (our tools exposed as in-process MCP tools; built-in SDK tools disabled via `disallowedTools`, `settingSources: []`), `stream-mapper.ts` (SDK stream → `ProviderEvent`s), `env.ts` (subscription-env builder), `README.md` (policy position, limits, status: unpublished, spike pending), tests beside
- Modify: root `package.json` (`workspaces: ["packages/*"]` only if it does not disturb root scripts; root `vitest` include extends to `packages/*/src/**/*.tests.ts`; root `tsconfig` excludes packages from the main build; CI builds packages separately), `.github/workflows/ci.yml`, README mention
- Test: beside with a `FakeClaudeAgentRunner`

**Interfaces (binding):** `claudeCode(options: { runner?: ClaudeAgentRunner; model?: string; useSubscriptionAuth?: boolean (default false); allowedTools: never[]; cwd?; env?: Record<string,string> }): Provider` with `capabilities = { streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 200_000, ownsLoop: true }` (add optional `ownsLoop?: boolean` to `ProviderCapabilities` in core; when true the core turn runner switches to **delegated mode**: it sends the whole conversation + tool bridge to the provider ONCE, tool calls arrive as `tool-call` events that the provider's bridge executes *in our process through a callback* (`ProviderRequest.toolExecutor`), and results flow back inside the same stream; core records steps/telemetry from the callback so scoring, cache, approvals, guardrails, dry-run, ledger all still apply). `ClaudeAgentRunner = { run(params: { prompt; system; model?; tools: BridgedTool[]; env; cwd; signal; includePartialMessages: true }): AsyncIterable<SdkMessage> }`; default runner dynamically imports the SDK and throws a clear error if absent (never imported at module load). `env.ts`: when `useSubscriptionAuth` true, returns a copy of `process.env` without `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (explicit, logged once at warning level via an event); never reads credential files (a test scans the package source for `.credentials`, `keychain`, `oauth` string reads). `stream-mapper` maps text deltas, thinking, tool_use (bridge-handled, not re-emitted as pending), usage (`usage`, `modelUsage`, `num_turns`), result/error, abort ⇒ runner `signal` + subprocess kill. Core change in this task: delegated-mode support in `run-agent-turns` (when `capabilities.ownsLoop`): single `provider.stream` call per user turn with `request.toolExecutor(call) => Promise<ToolEnvelope-like result>` provided by core's dispatcher; features needing loop ownership degrade with a one-time `warning` event.

- [ ] **Step 1: Failing tests**: env builder table + source scan; stream mapper fixtures (text, thinking, tool_use via bridge, usage, error, abort); tool bridge conversion (schemas, names, in-process execution through the core dispatcher: cache/approval/guardrail/dry-run observed in a scripted run with the fake runner); delegated-mode core behaviour with a fake `ownsLoop` provider (single stream call, tool executor invoked, steps recorded, abort propagates, degrade warning once); package builds standalone (`tsc -p packages/claude-code`); `private: true` asserted; root pack excludes the package; core has no import of the package (scan).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: unpublished Claude Code provider package and delegated-loop mode`.

---

## Self-review

Coverage: plugins (T0), MCP (T1), Claude Code package + delegated loop (T2). The live spike (tool disabling, `tool_use` interception, Windows behaviour) remains pending because it requires the real SDK/CLI and the user's subscription; the package README says so. Names: `Plugin`, `PluginHooks`, `McpServerConfig`, `McpTransport`, `ClaudeAgentRunner`, `ProviderCapabilities.ownsLoop`.
