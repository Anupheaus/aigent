# Roadmap and progress

Source of truth for scope: the approved master plan (`docs/design/master-plan.md`). Each slice below has its own spec and plan in `docs/superpowers/{specs,plans}/` and ends reviewed, fixed, and pushed on branch `phase-1-foundation`.

Standing rules: no downloads other than npm packages (no Ollama/models), no live API calls, no publishing, commits and pushes to the feature branch are authorised. Decisions taken autonomously are recorded in each slice's plan under "Rulings".

| # | Slice | Status |
|---|-------|--------|
| 1 | Foundation core (loop, tools, store, directives) | done |
| 2 | Providers (OpenAI-compatible, Anthropic, contract suite) | done |
| 3 | Model settings, provider resilience (retry/fallback), shared scheduler | done |
| 4 | Run records, scoring, report, feedback tools, user feedback, analysis | done |
| 5 | Tool-result cache, shaper pipeline (verbatim-safe), volatile block, plan/todo tools | done |
| 6 | Context layout, compaction, `Compressor` interface | done |
| 7 | Chat: conversation model, patches, ask_user, queue/steer, threads, forks | done |
| 8 | Resumable instances: checkpoints, leases, exactly-once; approvals | done |
| 9 | Guardrails, dry-run and undo | done |
| 10 | Filesystem pack + FsPolicy, data/format pack, agent/meta pack (delegate) | done |
| 11 | HTTP/web pack, code-intelligence pack | done |
| 12 | Shell pack, git pack | done |
| 13 | Database pack, knowledge/RAG pack | done |
| 14 | Plugins (`definePlugin`), MCP plugin, Claude Code plugin package (unpublished) | done |
| 15 | Benchmark suite and optimisation rounds (scripted tiers only) | done |
| 16 | Memory (Phase 2) | todo |
| 17 | Efficiency: routing and caching (Phase 3) | todo |
| 18 | Strategy learning (Phase 4), skill learning (Phase 5) | todo |
| 19 | Adapters: file store, Mongo store, embeddings recall (Phase 6) | partly built on branch `slices-18-20-offline`: contract suite, file store, Mongo store (fake-tested); vector index and embedding recall still todo (need slices 13 and 16) |
| 20 | Packaging, release, docs, examples | todo |

Known limits of this autonomous run: anything needing a model download, a running Ollama, paid API keys, a real MongoDB, or the Claude Code binary is built against interfaces and fakes, with live tests gated off.
