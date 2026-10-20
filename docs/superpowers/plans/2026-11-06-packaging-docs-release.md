# Packaging, Release, Docs and Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Make the library shippable and understandable: audited `exports` map and package contents, Changesets-based versioning and a release workflow (written, never run), generated API reference (TypeDoc) and an API-extractor report gate, concept guides, an `examples/` workspace that CI type-checks and smoke-tests against the fake provider, CONTRIBUTING, and a final repo-wide consistency review.

**Architecture:** Config and docs only plus small scripts; no runtime behaviour changes except fixes found by the audits. Examples depend on the built package via workspace linking and run against `createFakeProvider` so they need no network.

**Tech Stack:** `@changesets/cli`, `typedoc`, `@microsoft/api-extractor` (dev dependencies; npm install allowed), `react` + `@types/react` + `react-dom` for the React example (dev dependencies of the examples workspace only), vitest for smoke tests.

**Spec:** master plan "Packaging, CI, docs and examples" in `C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`.

## Global Constraints

Same as the foundation plan's Global Constraints, plus: **never publish, never run the release workflow, never push tags** (workflow file only; the user decides when to publish); `npm pack --dry-run` content is asserted by a test; sub-path entries all have types; the Claude Code package stays `private` and excluded from release; examples must not contain real keys or network calls; docs are accurate to the code (every code block in README/guides is compiled by a docs test).

## Review Focus

1. `npm pack` contains exactly `dist/**`, `README.md`, `LICENSE`, `package.json` (+ declared extras), every `exports` entry resolves to an existing file with types, importing every entry point in a fresh temp project (installed from the packed tarball) works and does not load optional peers (vitest, mongodb, typescript, claude SDK) unless the entry needs them.
2. API-extractor report gate fails on an accidental public-API change and passes after an intentional update of the committed report.
3. Docs truthfulness: code blocks in README and guides are extracted and type-checked; examples build and their smoke tests run in CI against the fake provider.
4. Release workflow safety: triggers only on version tags, uses `--provenance`, requires `contents: read`/`packages: write`/`id-token: write`, has a dry-run mode, never runs on pull requests.

---

### Task 0: Package audit, Changesets, API report, TypeDoc

**Files:**
- Create: `.changeset/config.json`, `.changeset/README.md`, `.github/workflows/release.yml`, `api-extractor.json` (+ per-entry configs or a script iterating entries), `etc/api/*.api.md` (committed reports), `typedoc.json`, `scripts/check-pack.mjs`, `scripts/check-entry-points.mjs` (installs the tarball into a temp project and imports every entry), `scripts/extract-doc-snippets.mjs`, `src/docs-snippets.tests.ts`
- Modify: `package.json` (scripts `api:check`, `api:update`, `docs`, `check:pack`, `check:entries`, `changeset`, `version-packages`; `files`; `sideEffects`; `engines`), `.github/workflows/ci.yml` (lint-free typecheck, tests, coverage threshold via vitest `--coverage` with `@vitest/coverage-v8` thresholds 85% lines/80% branches on `src/` excluding test-support, build, pack/entries checks, API report check, TypeDoc build without warnings, `npm audit --omit=dev --audit-level=high`, dependency review on PRs, matrix ubuntu+windows × node 20/22; local-model job gated by label/schedule documented but disabled by default), README
- Test: beside + scripts exercised in CI

**Interfaces (binding):** entry points audited: `.`, `./testing`, `./testing/contract`, `./tools/fs`, `./tools/data`, `./tools/meta`, `./tools/web`, `./tools/code`, `./tools/shell`, `./tools/git`, `./tools/db`, `./tools/knowledge`, `./tools/index`, `./mcp`, `./stores/mongo`, `./memory` (if present) — each with `types` + `import` conditions; optional peers declared in `peerDependenciesMeta`; `check-entry-points` packs the repo, installs the tarball into a temp dir with `npm i <tarball>` (local file, no registry), and for each entry runs `node --input-type=module -e "await import('@anupheaus/aigent/<entry>')"` asserting success and (via a loader hook or `require.cache`-style module list printed by the child) that optional peers were not loaded by entries that do not need them; coverage thresholds enforced; changesets configured for single-package publishing to GitHub Packages (`access: public`, registry from `publishConfig`), `release.yml`: on `push` of tags `v*` only, jobs `verify` (same as CI) then `publish` (`npm publish --provenance`), `workflow_dispatch` input `dry-run` default true.

- [ ] **Step 1: Failing tests**: pack-content test (parse `npm pack --dry-run --json` output; assert allowed file patterns and absence of tests/test-support/bench/examples/docs-build); exports map test (every export path exists after build and has types); doc-snippet test (extract fenced `ts` blocks tagged `// compile` from README and `docs/guides/*.md`, type-check them against the package source via the TypeScript API); API report check script behaviour (fails on mutated report copy).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `chore: package audit, changesets, release workflow, API report and TypeDoc`.

---

### Task 1: Guides, examples, CONTRIBUTING and final review

**Files:**
- Create: `docs/guides/{getting-started,agents-and-tasks,chat,tools,providers,stores,caching-and-shaping,context-and-compaction,feedback-and-scoring,memory-and-learning,security,plugins-and-mcp,resume-and-approvals,benchmarking}.md`, `docs/README.md` index, `examples/package.json` (private workspace), `examples/{task-agent,chat-ui-react,fs-assistant-approvals,rag-assistant,custom-tool-and-plugin,ollama-offline,mcp-client}/` each with `index.ts`, `README.md`, and `*.smoke.tests.ts` (run against `createFakeProvider` / scripted providers; the Ollama example is type-checked only and documents `AIGENT_LIVE`), `CONTRIBUTING.md`, `SECURITY.md`
- Modify: README (restructure: pitch, install incl. GitHub Packages auth note, quick start, feature map linking guides, status/roadmap, licence), `.github/workflows/ci.yml` (examples typecheck + smoke job), `AGENTS.md` (final structure)
- Test: smoke tests + docs snippet test

**Interfaces (binding):** each guide has: purpose, a minimal compiled example (`// compile` tagged), the key options table (copied from types), pitfalls, and links; the security guide covers FsPolicy/HttpPolicy/ShellPolicy/DbPolicy deny-by-default, approvals, guardrails, dry-run/undo, privacy (redact/purge/captureContent), prompt-injection stance, the Claude Code plugin policy caveat; the examples cover the master plan's list; the React example uses `createConversationStore` with `useSyncExternalStore` (types from `@types/react`, not executed in CI beyond type-check).
- Final task step: run the whole verification suite, regenerate API reports and TypeDoc, and write `docs/superpowers/final-report.md` summarising what exists vs the master plan, every ruling made (collected from `.superpowers/sdd/*/` reports and plans), known limitations (anything needing models/keys/DBs not run), and the follow-up list.

- [ ] **Step 1: Failing tests**: example smoke tests (each example's main function runs with the fake provider and prints/returns the expected structure), docs snippet compile test covers the new guides, link checker for relative links in docs/README, examples workspace typecheck.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `docs: guides, examples, contributing and final report`.

---

## Self-review

Coverage: packaging/release/API gate/TypeDoc (T0), docs/examples/final report (T1). Publishing is deliberately never executed. Names: `check-pack`, `check-entry-points`, `api:check`.
