# @anupheaus/aigent-claude-code

A provider plugin for [`@anupheaus/aigent`](../../README.md) that runs Claude through **Claude Code** (the Claude Agent SDK, `@anthropic-ai/claude-agent-sdk`) instead of the Anthropic API.

> **Status: unpublished, personal use only.** This package is `"private": true` and is not built into or shipped with `@anupheaus/aigent`. It stays that way until the owner confirms the policy position below. The live spike against the real SDK and CLI has **not** been done: everything here is tested against a fake runner only.

## Policy position

- **Personal, local use only.** Anthropic does not permit third-party products to route requests through Claude Free/Pro/Max subscription credentials on behalf of their users, or to offer claude.ai login. A library that drives the SDK on end users' subscriptions would fall into that restricted group if distributed. This package is therefore not for distribution and must not be used to serve other people.
- **No credential handling.** The package never reads `~/.claude/` credential files, operating-system keychains or any login token, and never calls the Messages API with extracted credentials (which is prohibited). Authentication is whatever the Claude Code CLI itself does.
- **Subscription auth is opt-in.** With `useSubscriptionAuth: true` the provider removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the Claude Code subprocess environment (they win over the CLI's own login), and says so once through `onWarning` (default: a Node process warning, code `AIGENT_CLAUDE_CODE_SUBSCRIPTION_AUTH`). Without it the environment is passed through unchanged.
- Subscription limits assume ordinary individual use; programmatic use still counts against them. This is not legal advice; written confirmation from Anthropic is the safe route before distributing anything that uses subscription auth.

## Use

```ts
import { createAigent } from '@anupheaus/aigent';
import { claudeCodePlugin } from '@anupheaus/aigent-claude-code';

const ai = createAigent({ plugins: [claudeCodePlugin({ useSubscriptionAuth: true })] });
const agent = ai.agent({ name: 'coder', model: 'claude-code:claude-sonnet-5-5', tools: [/* your aigent tools */] });
```

`claudeCode(options)` is the bare provider (id `claude-code`). Options: `runner` (default: the SDK, loaded on first use; it is an optional peer, and a clear `provider_failed` error explains a missing install), `model` (used for `claude-code:default`), `useSubscriptionAuth` (default false), `allowedTools` (only `[]`: built-in Claude Code tools are never allowed), `cwd`, `env`, `onWarning`.

## How it works: delegated loop

The SDK always runs its own agent loop, so the provider declares `capabilities.ownsLoop: true` and the core switches to **delegated mode**:

- Each turn is **one** SDK run. The system prompt, plus the volatile `# Current state` block (plan, todo, progress), becomes the system prompt; the conversation becomes the prompt (a transcript once there is history).
- Our tools are exposed as one in-process MCP server (`mcp__aigent__<tool>`). Every built-in Claude Code tool is listed in `disallowedTools`, `settingSources` is empty and a permission callback denies anything that is not a bridged tool.
- When Claude calls a tool, the bridge hands it to the core through `ProviderRequest.toolExecutor`, which runs it exactly like any other call: argument validation, guardrails, approvals, the cache, dry runs, the call ledger, the effect log and telemetry. The result envelope goes back to the SDK.
- The stream is mapped to provider events: partial text and thinking deltas (`includePartialMessages`), one usage event (`modelUsage` summed over models when present, else `usage`), then `done` (`length` for `max_tokens` or the SDK's turn limit). An error result is `provider_failed`; a stream that breaks or ends without a result is retryable `provider_failed`. A stop aborts the SDK run, which kills its subprocess.

What degrades (the run emits one warning saying so): steering, compaction, plan and todo directives and checkpoints apply only between turns, not between tool rounds inside a turn; `maxTurns` counts SDK runs; `num_turns` is not recorded; model settings are not supported (the SDK takes none) and are reported as ignored; thinking blocks are not replayed.

## Pending live spike

Not verified, because it needs the real SDK, the CLI and the owner's subscription: that `disallowedTools` (rather than the undocumented `tools: []`) disables every built-in tool; that in-process MCP tools receive their arguments through the pass-through schema used here; the exact stream and usage fields; streaming-input behaviour; session handling; and Windows behaviour. Until then `createSdkRunner` is a best-effort adapter.

## Development

This package lives in the core repository but is built separately: `npx tsc -p packages/claude-code` type-checks it against the core's source, and `npx tsc -p packages/claude-code/tsconfig.build.json` (after the core's `npm run build`) compiles it to `dist`. Its tests run with the core's `npm test`.
