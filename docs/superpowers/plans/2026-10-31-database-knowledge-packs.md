# Database and Knowledge (RAG) Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `@anupheaus/aigent/tools/db` (read-only parameterised `db_query` over a `DbAccess` interface, MongoDB adapter as an optional peer-dependency plugin file) and `@anupheaus/aigent/tools/knowledge` (`knowledge_search`, `knowledge_read`, consumer-side `knowledge.index/remove`) with pluggable `Embedder` and `VectorIndex`, chunking, hybrid search, freshness, citations.

**Architecture:** Databases are reached only through `DbAccess` (`find`, `count`, `aggregate`-free) behind a `DbPolicy` that enforces per-collection permissions, operator allowlists (no `$where`, `$function`, `$accumulator`, `$out`, `$merge`, JavaScript execution), field projections, limits and timeouts. Knowledge is a self-contained library: sources → chunker → embedder → index; search combines vector similarity with BM25-style keyword scoring and optional reranking; everything deterministic given an index version, so it caches globally.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check. `mongodb` as an optional peer dependency (adapter only; tests use a fake `DbAccess` and the in-memory implementation — **no live MongoDB** in this run; a gated live test is provided). In-house BM25, cosine, chunkers. Embeddings via provider embedding endpoints are an adapter (`openAiEmbedder` using injected fetch; tested with mocked HTTP) and a deterministic `hashEmbedder` for tests/offline.

**Spec:** master plan sections "Database (read-only parameterised db_query, MongoDB first)", "Retrieval / RAG pack (knowledge)", security bullets for database/knowledge in `C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`; pack conventions in `docs/superpowers/plans/2026-10-28-fs-data-meta-packs.md`.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: no network and no real database in default tests; **read-only by construction** (the `DbAccess` interface has no write methods exposed to tools); deny by default (no collection permissions ⇒ everything refused); query values are parameters, never string-concatenated; fs-sourced indexing obeys `FsPolicy`; knowledge results carry citations.

## Review Focus

1. Operator injection: filters containing `$where`, `$function`, `$expr` with disallowed operators, `$regex` with pathological patterns, `$lookup` into forbidden collections, `$out/$merge`, `$accumulator`, `$jsonSchema` abuses, prototype-pollution keys (`__proto__`, `constructor`), deeply nested filters, huge `$in` arrays, field paths with `$` prefixes — all rejected with precise errors before reaching `DbAccess`; projection cannot expose denied fields.
2. Limits: result size/doc count/time caps enforced, cursors closed on abort, large documents truncated with markers (not silently), `maxResultTokens` honoured.
3. Retrieval quality: on a fixture corpus with known relevant chunks, hybrid search recall@k / MRR meets thresholds the plan states (assert numbers), exact-keyword queries beat pure vector on identifiers, near-duplicate chunks are collapsed, filters restrict correctly.
4. Freshness: changed/removed/renamed sources are re-indexed or dropped (no stale chunks served), incremental indexing touches only changed files (assert embedder call counts), chunk ids are stable across runs for unchanged text.
5. Determinism and caching: identical queries on the same index version produce byte-identical results and hit the global cache; a new index version invalidates.

---

### Task 0: Database pack

**Files:**
- Create: `src/security/db-policy.ts`, `src/security/db-policy-types.ts`, `src/security/filter-validate.ts`, `src/tools/packs/db/` (`db-tools.ts`, `db-query.ts`, `db-access.ts`, `memory-db-access.ts`, `mongo-db-access.ts`), barrel `index.ts`
- Modify: `package.json` (`peerDependencies.mongodb` optional, exports `./tools/db`), README
- Test: beside + `filter-validate.property.tests.ts`

**Interfaces (binding):** `DbPolicyOptions = { collections: Record<string, { permissions: ('read')[]; allowFields?: string[]; denyFields?: string[]; maxLimit?: number (default 200); maxTimeMs?: number (default 5000); allowOperators?: string[] }> ; maxDepth: 8; maxArrayLength: 1000 }`. `validateQuery(policy, request)` returns `{ ok, query } | { ok:false, code, message, path }`. Allowed filter operators default: `$eq $ne $gt $gte $lt $lte $in $nin $and $or $nor $not $exists $type $regex(with length ≤ 200, no nested quantifiers) $size $all $elemMatch`; projection/sort fields must be allowed paths. `DbAccess = { find(params: { collection; filter; projection?; sort?; limit; skip?; maxTimeMs; signal }): Promise<{ docs: Record<string, unknown>[]; truncated: boolean }>; count(...): Promise<number> }`. `db_query` (batch ≤ 5 items): `{ collection, filter?: JSON object, projection?: string[], sort?: [{ field, direction: 'asc'|'desc' }], limit? (≤ policy.maxLimit), skip?, count?: boolean }` ⇒ `{ collection, docs, count?, returned, truncated }`; values are passed as parameters only; `deterministic:false, cache:true` with short TTL default 30_000 (configurable, can be disabled); results `structured-data`, `fidelity:'lossy-ok'` (tabular shaper applies) with `raw`-free; `maxResultTokens`; ObjectId/Date/Decimal values serialised as tagged JSON (`{ $oid }`, `{ $date }`) in a documented way; denied/hidden fields removed server-side via projection AND client-side post-filter. Mongo adapter maps to `collection.find` with `maxTimeMS`, never `aggregate`; BSON types converted; cursor closed in `finally`. Memory adapter supports the same operator subset for tests.

- [ ] **Step 1: Failing tests**: Review Focus 1 corpus (each case rejected with a code and path); allowed queries matching a reference in-memory evaluation (operator semantics parity tests over a generated document set, property-style); field deny/allow; limits and truncation markers; abort closes cursor (fake); Mongo adapter against a fake `Collection` double (documented methods) asserting it never calls anything but `find`/`countDocuments` and passes `maxTimeMS`; a gated live test (`AIGENT_LIVE_MONGO` URL) skipped by default; cache TTL behaviour; activity views; unattended and approvals not required (read-only) but `requiresApproval` option supported for sensitive collections.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: database pack with read-only policy-validated queries`.

---

### Task 1: Knowledge core (chunking, embedding, index, search)

**Files:**
- Create: `src/knowledge/chunker.ts` (text/markdown/code splitters), `embedder.ts` (interface + `hashEmbedder`, `openAiEmbedder`), `vector-index.ts` (interface), `memory-vector-index.ts`, `file-vector-index.ts` (JSON-lines, atomic write), `bm25.ts`, `hybrid-search.ts`, `mmr.ts`, `knowledge-base.ts` (`createKnowledgeBase`), `source-scan.ts`
- Test: beside, fixture corpus `src/knowledge/fixtures.test-support.ts` (≈40 short docs with labelled relevance judgments)

**Interfaces (binding):** `Embedder = { id: string; dimensions: number; embed(texts: string[], signal?): Promise<number[][]> }`; `VectorIndex = { upsert(chunks: IndexedChunk[]): Promise<void>; remove(filter: { sourceId?: string; chunkIds?: string[] }): Promise<void>; query(params: { vector: number[]; k: number; filter?: MetadataFilter }): Promise<{ chunkId; score }[]>; get(chunkId): Promise<IndexedChunk | undefined>; list(sourceId?): Promise<IndexedChunk[]>; version(): Promise<string> }`; `IndexedChunk = { chunkId (sha-256 of sourceId+span+text, stable), sourceId, uri, span: { start: number; end: number; startLine?: number; endLine?: number }, text, metadata: Record<string, string|number|boolean>, vector?: number[], contentHash }`. Chunking: target 800 chars (configurable), overlap 100, structural splits (markdown headings keep the heading path in metadata `section`, code splits at top-level declaration boundaries with a regex fallback by blank lines, plain text at paragraph then sentence boundaries), never splits inside a fenced code block unless it exceeds 2× target. `createKnowledgeBase({ embedder, index, chunker?, clock })` ⇒ `{ index({ sources }): Promise<IndexReport>, remove({ sourceIds }), search(request): Promise<SearchResult[]>, read(chunkId | { sourceId; span }), version() }`; `sources` = `{ id; uri; text?; path?; metadata? }` (path sources read via injected `FsAccess` + `FsPolicy`); freshness by `contentHash` (+ mtime when path-based): unchanged sources skipped (embedder not called), changed sources re-chunked with only changed chunks re-embedded (match by chunkId), removed chunks dropped. `search({ query, k (≤20), filter?, mode: 'hybrid'|'vector'|'keyword' (default hybrid), rerank?: (query, candidates) => Promise<candidates> , mmrLambda? })` ⇒ results `{ chunkId, sourceId, uri, span, score, snippet (query-focused trimmed to ≤ 400 chars), citation: { sourceId, chunkId, uri, span } }`; hybrid = reciprocal-rank fusion of vector top-50 and BM25 top-50, then MMR/near-duplicate collapse (Jaccard of shingles ≥ 0.9), deterministic tie-breaks (score desc, chunkId asc). `version()` = hash of sorted chunk ids + contentHashes + embedder id.

- [ ] **Step 1: Failing tests**: chunker properties (concatenated spans cover the text, overlap bound, no empty chunks, stable ids, code-fence rule); BM25 vs hand-computed scores; cosine/RRF/MMR unit tests; retrieval-quality assertions on the fixture corpus with `hashEmbedder` (recall@5 ≥ the thresholds the test file declares from a measured baseline, MRR ≥ declared, identifier queries rank the exact-token doc first); freshness (embedder call counts for unchanged/changed/removed); atomic file index (crash-injected write leaves previous state readable) and reload equality; filters; determinism and version changes; openAiEmbedder with mocked fetch (batching, retry-free, error mapping, no key in errors).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: knowledge base with chunking, hybrid search and freshness`.

---

### Task 2: Knowledge tools, citations, eval hook

**Files:**
- Create: `src/tools/packs/knowledge/` (`knowledge-tools.ts`, `knowledge-search.ts`, `knowledge-read.ts`), barrel `index.ts`, `src/knowledge/eval-retrieval.ts`
- Modify: `src/core/agent-types.ts` (`TaskResult.citations?: Citation[]`), `src/core/system-prompt.ts` (citation instruction, only when knowledge tools present, via the tool pack's `promptAddendum`), `src/tools/tool-types.ts` (`promptAddendum?: string` collected into the stable system prompt, sorted), `package.json` exports `./tools/knowledge`, README
- Test: beside + integration

**Interfaces (binding):** `knowledgeTools(options: { base: KnowledgeBase; maxResults?: number })`. `knowledge_search` (batch ≤ 5 queries): `{ query, k?, filter?: record<string, string|number|boolean>, mode? }` ⇒ per-query results as above; `deterministic: true, cache: true` with `cacheKey` = `indexVersion + normalised args` so the global cache serves repeats and a new index version invalidates; `contentKind:'search-hits'`, `fidelity:'verbatim'` for chunk text but snippet trimming is part of the tool (documented), `maxResultTokens` enforced by dropping lowest-ranked snippets first with a `truncated` marker. `knowledge_read` (batch ≤ 10): `{ chunkId }` or `{ sourceId, span }` ⇒ full chunk text + neighbours (prev/next ids). The agent is instructed to cite; `citations` on `TaskResult` are the union of citations of chunks returned by knowledge tools whose `chunkId` the final answer references (`[[cite:<chunkId>]]` markers stripped from visible text, parsed by a small answer post-processor) — message meta citations for chat. `evalRetrieval({ base, cases })` ⇒ `{ recallAtK, mrr, perCase }` used in tests and exported for consumers.

- [ ] **Step 1: Failing tests**: tools vs a built fixture base; cache hit on repeat and miss after re-index; truncation; read neighbours; citation marker parsing (including malformed markers left alone, unknown chunk ids dropped with a warning); prompt addendum appears once and is cache-stable; unregistered when no base; fs-sourced indexing denied outside roots; end-to-end agent loop answering from the corpus with citations (FakeProvider scripted); `evalRetrieval` numbers.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: knowledge tool pack with citations and retrieval eval`.

---

## Self-review

Coverage: db (T0), knowledge core (T1), knowledge tools/citations (T2). Live Mongo and real embedding services are gated off. Names: `DbPolicy`, `DbAccess`, `Embedder`, `VectorIndex`, `IndexedChunk`, `KnowledgeBase`, `Citation`.
